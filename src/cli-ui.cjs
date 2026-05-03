/**
 * `autopg ui [--port N] [--no-open]` (also reachable via `pgserve ui`).
 *
 * Boots a tiny http server bound to 127.0.0.1 that:
 *   - serves the static console at `console/` (React + Babel CDN, no build).
 *   - exposes 4 helper endpoints used by the SPA:
 *       GET  /api/settings   → { settings, sources, etag }
 *       PUT  /api/settings   → writeSettings + If-Match etag check
 *       POST /api/restart    → invokes cli-restart.dispatch
 *       GET  /api/status     → shells out to the existing wave-1 status
 *
 * Single-user dev tool: 127.0.0.1 only, no auth, no TLS. Designed to ride
 * inside an operator's localhost session — not to be exposed.
 *
 * Port selection:
 *   --port N      → bind exactly N or fail.
 *   (no flag)     → walk 8433..8533 picking the first free port.
 *
 * Browser opening:
 *   --no-open     → skip browser launch (CI/headless paths).
 *   default       → `open` (macOS) / `xdg-open` (Linux) / `start` (Windows).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const { loadEffectiveConfig, getSettingsPath } = require('./settings-loader.cjs');
const { writeSettings } = require('./settings-writer.cjs');
const cliRestart = require('./cli-restart.cjs');

// `pg` is a devDependency today — graceful degradation if not installed.
// /api/stats returns { ok: false, reason: 'pg-not-installed' } in that case.
let PgClient = null;
try { PgClient = require('pg').Client; } catch { /* optional */ }
const {
  ValidationError,
  EtagMismatchError,
  ERROR_CODES,
} = require('./settings-validator.cjs');

const PORT_RANGE_START = 8433;
const PORT_RANGE_END = 8533;
const HOST = '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function parseArgs(args) {
  const out = { port: null, noOpen: false, host: HOST };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      const v = args[++i];
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port "${v}"`);
      }
      out.port = n;
    } else if (a === '--no-open') {
      out.noOpen = true;
    } else if (a === '--host') {
      const v = args[++i];
      out.host = v;
      // Loud warning on non-loopback. The console has no auth, no TLS —
      // exposing it on the LAN means any host on the network reads your
      // settings file. Accepted (operator opted in) but flagged.
      if (v !== '127.0.0.1' && v !== 'localhost') {
        process.stderr.write(
          `autopg ui: WARNING binding to ${v} (not loopback) — console has no auth, anyone reaching this address can read settings\n`,
        );
      }
    }
  }
  return out;
}

/**
 * Try to bind a server on each candidate port until one succeeds.
 * Returns a Promise<{server, port}>. Rejects if no port in the range works.
 */
function listenWithFallback(server, host, preferredPort) {
  const candidates = preferredPort
    ? [preferredPort]
    : (() => {
        const list = [];
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) list.push(p);
        return list;
      })();

  return new Promise((resolve, reject) => {
    let i = 0;
    function attempt() {
      if (i >= candidates.length) {
        reject(
          new Error(
            preferredPort
              ? `port ${preferredPort} is not available`
              : `no free port in ${PORT_RANGE_START}-${PORT_RANGE_END}`,
          ),
        );
        return;
      }
      const port = candidates[i++];
      const onErr = (err) => {
        if (err.code === 'EADDRINUSE' && !preferredPort) {
          server.removeListener('error', onErr);
          attempt();
          return;
        }
        reject(err);
      };
      server.once('error', onErr);
      server.listen(port, host, () => {
        server.removeListener('error', onErr);
        resolve({ server, port });
      });
    }
    attempt();
  });
}

/**
 * Resolve the static document root. The console directory lives at the
 * repo root (alongside `bin/` and `src/`). When the package is installed
 * via npm the `files` allowlist preserves the layout.
 */
function resolveConsoleRoot() {
  // After autopg-console-dist (v2.2.2): the SPA ships pre-bundled in
  // console/dist/ instead of as flat .jsx files at console/. Prefer dist/;
  // fall back to console/src/ for repo-checkout dev mode (where dist/ is
  // gitignored and only built on demand).
  const consoleParent = path.resolve(__dirname, '..', 'console');
  const distRoot = path.join(consoleParent, 'dist');
  if (fs.existsSync(distRoot)) return distRoot;

  const srcRoot = path.join(consoleParent, 'src');
  if (fs.existsSync(srcRoot)) {
    process.stderr.write(
      'autopg ui: running unbuilt sources from console/src/ — run `bun run console:build` for production behavior\n',
    );
    return srcRoot;
  }

  throw new Error(
    'console assets not found: expected console/dist/ (run `bun run console:build`) or console/src/ (repo checkout)',
  );
}

/**
 * Sanitize a request path against directory traversal, return the absolute
 * file path on disk or null if the request escapes the document root.
 */
function safeJoin(root, urlPath) {
  // Strip query string defensively even though the caller already removed it.
  const clean = urlPath.split('?')[0];
  // Normalize then refuse anything starting with `..` or absolute outside
  // the root.
  const decoded = decodeURIComponent(clean);
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '');
  const candidate = path.resolve(root, normalized);
  if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) {
    return null;
  }
  return candidate;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

function readBody(req, { limitBytes = 1_048_576 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ─── handlers ────────────────────────────────────────────────────────────

/**
 * Read pgserve install metadata (~/.autopg/config.json). This file is the
 * load-bearing source for what the daemon is ACTUALLY using (port +
 * dataDir + registeredAt) — settings.json is operator-editable and can
 * drift, especially after the ~/.pgserve → ~/.autopg rename migration.
 * Returns null if the file is missing or unreadable.
 */
function readInstallConfig() {
  try {
    const installCfgPath = path.join(
      process.env.AUTOPG_CONFIG_DIR || path.join(require('node:os').homedir(), '.autopg'),
      'config.json',
    );
    return JSON.parse(fs.readFileSync(installCfgPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Apply runtime overlays to the loaded settings tree before serializing
 * for the UI. Three fixes for v2.2.5 settings-vs-reality drift:
 *
 *   1. server.pgPort — the schema default (6432) is misleading; cluster.js
 *      computes effective as `server.port + 1000` when pgPort is the
 *      schema default. Show the effective value, not the stale literal.
 *   2. runtime.dataDir — install writes to config.json, settings.json
 *      can stay stale (the rename migration left it pointing at
 *      ~/.pgserve/data). Authoritative source is config.json. Overlay.
 *   3. server.pgPassword — never return cleartext in API responses, even
 *      with Basic Auth gating the endpoint. Mask to '***'.
 *
 * The original (file-shape) values are still on disk in settings.json,
 * so PUT /api/settings round-trips correctly when the operator edits.
 */
function applyEffectiveOverlays(settings) {
  const overlay = JSON.parse(JSON.stringify(settings)); // structured clone
  const installCfg = readInstallConfig();

  // 1. effective pgPort
  if (overlay?.server) {
    const SCHEMA_DEFAULT_PG_PORT = 6432;
    if (overlay.server.pgPort === SCHEMA_DEFAULT_PG_PORT && typeof overlay.server.port === 'number') {
      overlay.server.pgPort = overlay.server.port + 1000;
      overlay.server._pgPortResolution = 'computed';
    }
  }

  // 2. effective dataDir from install config
  if (installCfg?.dataDir && overlay?.runtime) {
    if (overlay.runtime.dataDir !== installCfg.dataDir) {
      overlay.runtime._dataDirOverride = {
        from: overlay.runtime.dataDir,
        to: installCfg.dataDir,
        source: 'config.json',
      };
      overlay.runtime.dataDir = installCfg.dataDir;
    }
  }

  // 3. mask password fields
  if (overlay?.server?.pgPassword) overlay.server.pgPassword = '***';

  return overlay;
}

function handleGetSettings(req, res) {
  try {
    const { settings, sources, etag, path: settingsPath } = loadEffectiveConfig();
    const effective = applyEffectiveOverlays(settings);
    sendJson(res, 200, { settings: effective, sources, etag, path: settingsPath });
  } catch (err) {
    sendError(res, 500, 'LOAD_FAILED', err.message ?? String(err));
  }
}

async function handlePutSettings(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'BAD_BODY', err.message ?? 'invalid JSON');
    return;
  }
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    sendError(res, 428, 'PRECONDITION_REQUIRED', 'If-Match header required');
    return;
  }
  try {
    // Merge the patch onto the current effective tree before writing so
    // partial PUTs only touch the supplied keys. The writer re-validates.
    const { settings: current } = loadEffectiveConfig();
    const merged = deepMergePlain(current, body);
    const { etag } = writeSettings(merged, { ifMatch });
    sendJson(res, 200, { ok: true, etag });
  } catch (err) {
    if (err instanceof EtagMismatchError) {
      sendJson(res, 409, {
        error: {
          code: ERROR_CODES.ETAG_MISMATCH,
          message: 'settings changed on disk; reload before retry',
        },
        currentEtag: err.currentEtag,
      });
      return;
    }
    if (err instanceof ValidationError) {
      sendError(res, 400, err.code, err.detail ?? err.message, { field: err.field });
      return;
    }
    sendError(res, 500, 'WRITE_FAILED', err.message ?? String(err));
  }
}

/**
 * POST /api/data-dir { dataDir: <absolute path> }
 *
 * v2.2.5: SETS the configured data directory. Does NOT physically move
 * existing data — that operation is destructive and lives in the CLI:
 *   `autopg data-dir move <from> <to>` (deferred to v2.3 wish).
 *
 * What this endpoint does:
 *   - validate target is an absolute path
 *   - validate target's parent exists and is writable
 *   - refuse if the daemon is currently online (operator must
 *     `autopg uninstall && autopg install --data <new>`, or wait for
 *     v2.3 move flow)
 *   - write target into both ~/.autopg/settings.json (runtime.dataDir)
 *     and ~/.autopg/config.json (dataDir) so the next install picks it up
 *
 * Body:
 *   { dataDir: '/path/to/new/dir' }
 * Response on success: 202 Accepted
 *   { ok: true, dataDir, requiresReinstall: true }
 */
async function handlePostDataDir(req, res, ctx) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendError(res, 400, 'BAD_BODY', err.message ?? 'invalid JSON');
  }
  const { dataDir } = body || {};
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    return sendError(res, 400, 'INVALID_DATADIR', '`dataDir` must be a non-empty string');
  }
  if (!path.isAbsolute(dataDir)) {
    return sendError(res, 400, 'INVALID_DATADIR', '`dataDir` must be an absolute path');
  }
  const parent = path.dirname(dataDir);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    return sendError(res, 400, 'PARENT_NOT_WRITABLE', `parent directory not writable: ${parent}`);
  }

  // Refuse the live-edit path if a daemon is running. v2.2.5 ships the
  // SET-the-config path; the destructive MOVE flow is in the v2.3 wish.
  try {
    const cliInstall = require('./cli-install.cjs');
    const status = cliInstall._internals?.pm2GetProcess?.('pgserve');
    if (status && status.pm2_env?.status === 'online') {
      return sendError(res, 409, 'DAEMON_ONLINE',
        'pgserve daemon is online; configured dataDir change requires reinstall.\n' +
        'To migrate existing data: autopg uninstall && rsync -a <old> <new>/ && autopg install --data <new>',
        { requiresReinstall: true });
    }
  } catch {
    // soft-fail — if pm2 unavailable, allow the config write
  }

  // Update settings.json (runtime.dataDir) AND config.json (dataDir).
  try {
    const { settings: current } = loadEffectiveConfig();
    const merged = deepMergePlain(current, { runtime: { dataDir } });
    writeSettings(merged); // admin op — no etag check (no concurrent edit expected)
  } catch (err) {
    return sendError(res, 500, 'SETTINGS_WRITE_FAILED', err.message ?? String(err));
  }
  try {
    const installCfgPath = path.join(
      process.env.AUTOPG_CONFIG_DIR || path.join(require('node:os').homedir(), '.autopg'),
      'config.json',
    );
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(installCfgPath, 'utf8')); } catch { return {}; } })();
    cfg.dataDir = dataDir;
    fs.writeFileSync(`${installCfgPath}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(`${installCfgPath}.tmp`, installCfgPath);
  } catch (err) {
    return sendError(res, 500, 'CONFIG_WRITE_FAILED', err.message ?? String(err));
  }

  sendJson(res, 202, {
    ok: true,
    dataDir,
    requiresReinstall: true,
    note: 'dataDir saved to settings.json + config.json. Run `autopg uninstall && autopg install` to apply, or rsync existing data to the new path first.',
  });
}

/**
 * GET /api/screens/<name>
 *
 * v2.2.5: per-screen GET endpoints so each screen owns a narrow, focused
 * data shape. Most screens still ship as stubs — full implementations
 * land in v2.3+ alongside the autopg-v22 control-plane work.
 *
 * Known screens (from console/src/app.jsx SECTIONS):
 *   databases, tables, sql, optimizer, security, ingress, health, sync,
 *   rlm-trace, rlm-sim, settings.
 *
 * `settings` is special-cased: the existing /api/settings endpoint stays
 * authoritative; /api/screens/settings just returns a pointer.
 */
const KNOWN_SCREENS = {
  databases: { status: 'coming-soon', dataShape: { databases: '[{name, sizeBytes, owner, ...}]' } },
  tables: { status: 'coming-soon', dataShape: { tables: '[{schema, name, rowCount, sizeBytes, ...}]' } },
  sql: { status: 'coming-soon', dataShape: { recentQueries: '[{sql, durationMs, ts}]' } },
  optimizer: { status: 'coming-soon', dataShape: { suggestions: '[{kind, severity, target, recommendation}]' } },
  security: { status: 'coming-soon', dataShape: { roles: '[{name, login, superuser, ...}]', pgHbaLines: 'number' } },
  ingress: { status: 'coming-soon', dataShape: { activeConnections: 'number', byApplication: '[{name, count}]' } },
  health: { status: 'coming-soon', dataShape: { /* covered by /api/stats today */ pointer: '/api/stats' } },
  sync: { status: 'coming-soon', dataShape: { lastSyncAt: 'iso8601 | null', upstreamUrl: 'string | null' } },
  'rlm-trace': { status: 'coming-soon', dataShape: { traces: '[{id, fingerprint, startedAt, durationMs}]' } },
  'rlm-sim': { status: 'coming-soon', dataShape: { simulations: '[{id, scenario, status}]' } },
  settings: { status: 'see-settings-endpoint', pointer: '/api/settings' },
};

function handleGetScreen(req, res, screenName) {
  const screen = KNOWN_SCREENS[screenName];
  if (!screen) {
    return sendError(res, 404, 'UNKNOWN_SCREEN',
      `unknown screen "${screenName}". Known: ${Object.keys(KNOWN_SCREENS).join(', ')}`);
  }
  sendJson(res, 200, { screen: screenName, ...screen });
}

function deepMergePlain(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMergePlain(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function handlePostRestart(req, res, ctx) {
  try {
    const code = cliRestart.dispatch([], { scriptPath: ctx.scriptPath });
    if (code === 0) {
      sendJson(res, 200, { ok: true });
    } else {
      sendError(res, 500, 'RESTART_FAILED', `restart exited with code ${code}`);
    }
  } catch (err) {
    sendError(res, 500, 'RESTART_FAILED', err.message ?? String(err));
  }
}

function handleGetStatus(req, res, ctx) {
  // The existing wave-1 `status --json` flow returns the canonical shape.
  // Shell out via the wrapper so the response mirrors what an operator
  // would see at the CLI.
  try {
    if (ctx.statusOverride) {
      sendJson(res, 200, ctx.statusOverride());
      return;
    }
    const out = execFileSync(process.execPath, [ctx.scriptPath, 'status', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trimmed = out.trim();
    sendJson(res, 200, trimmed ? JSON.parse(trimmed) : {});
  } catch (err) {
    // `pgserve status` exits 1 when not installed but still prints JSON.
    // Surface the parsed payload when present; otherwise wrap the error.
    const stdout = err?.stdout ? err.stdout.toString().trim() : '';
    if (stdout) {
      try {
        sendJson(res, 200, JSON.parse(stdout));
        return;
      } catch {
        // fall through
      }
    }
    sendError(res, 500, 'STATUS_FAILED', err.message ?? String(err));
  }
}

// Cached package.json — read once at module load so we never block on disk.
const PKG_VERSION = (() => {
  try { return require('../package.json').version; } catch { return 'unknown'; }
})();

async function handleGetStats(req, res) {
  if (!PgClient) {
    sendJson(res, 200, {
      ok: false,
      reason: 'pg-not-installed',
      autopg: { version: PKG_VERSION },
    });
    return;
  }
  let client;
  try {
    const { settings } = loadEffectiveConfig();
    const server = settings.server || {};
    client = new PgClient({
      host: server.host || '127.0.0.1',
      port: server.port || 8432,
      database: 'postgres',
      user: server.pgUser || 'postgres',
      password: server.pgPassword || 'postgres',
      connectionTimeoutMillis: 1500,
      query_timeout: 1500,
    });
    client.on('error', () => {}); // never crash the helper on PG hiccup
    await client.connect();
    // Single round-trip query covering everything the footer needs.
    // pg_stat_activity gives client connections; pg_database the user-db
    // count + total size; pg_stat_database the cache + xact aggregates;
    // pg_settings for the short server_version (no parsing); and
    // pg_postmaster_start_time for uptime.
    const { rows: [row] } = await client.query(`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity
          WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()) AS connections,
        (SELECT count(*)::int FROM pg_database
          WHERE NOT datistemplate AND datname <> 'postgres') AS databases,
        (SELECT setting FROM pg_settings WHERE name = 'server_version') AS pg_version,
        EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))::int AS uptime_sec,
        (SELECT round(
          100.0 * sum(blks_hit)::numeric
            / nullif(sum(blks_hit) + sum(blks_read), 0),
          2
        )::float FROM pg_stat_database) AS cache_hit_pct,
        (SELECT sum(xact_commit + xact_rollback)::bigint
          FROM pg_stat_database) AS tx_total,
        (SELECT sum(pg_database_size(datname))::bigint
          FROM pg_database WHERE NOT datistemplate) AS size_bytes
    `);
    sendJson(res, 200, {
      ok: true,
      connections: row.connections,
      databases: row.databases,
      port: server.port || 8432,
      pg: {
        version: row.pg_version,
        uptimeSec: row.uptime_sec,
        cacheHitPct: row.cache_hit_pct,
        txTotal: Number(row.tx_total ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
      },
      autopg: { version: PKG_VERSION },
      ts: Date.now(),
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      reason: err.code || 'disconnected',
      message: err.message,
      autopg: { version: PKG_VERSION },
    });
  } finally {
    if (client) {
      try { await client.end(); } catch { /* already closed */ }
    }
  }
}

function handleStatic(req, res, root) {
  let url = req.url.split('?')[0];
  if (url === '/' || url === '') url = '/index.html';
  const target = safeJoin(root, url);
  if (!target) {
    sendError(res, 400, 'BAD_PATH', 'invalid path');
    return;
  }
  fs.stat(target, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      // SPA fallback: serve index.html on a miss so client routing works.
      const fallback = path.join(root, 'index.html');
      if (fs.existsSync(fallback)) {
        serveFile(res, fallback);
        return;
      }
      sendError(res, 404, 'NOT_FOUND', `no file at ${url}`);
      return;
    }
    serveFile(res, target);
  });
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 500, 'READ_FAILED', err.message);
      return;
    }
    res.writeHead(200, {
      'content-type': mime,
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/**
 * Build the request handler. `ctx.scriptPath` is the absolute path to
 * `bin/pgserve-wrapper.cjs` (used for shell-outs). `ctx.consoleRoot`
 * defaults to the repo's `console/` directory.
 */
// Lazy-load the auth verifier to avoid a require cycle with cli-install.
function getAuthVerifier() {
  try {
    return require('./cli-install.cjs').verifyAdminPassword;
  } catch {
    return () => false;
  }
}

/**
 * Basic Auth gate. Returns true if the request is authorized (or auth is
 * disabled via env), false if the response has been sent (401). The handler
 * MUST stop processing when this returns false.
 */
function requireAuth(req, res) {
  // Escape hatch: AUTOPG_DISABLE_AUTH=1 only honored when bound loopback.
  // The startServer loop binds to opts.host (default 127.0.0.1); this check
  // refuses the bypass when the request's interface isn't loopback to keep
  // it useful for CI/tests but useless for accidentally-exposed UIs.
  if (process.env.AUTOPG_DISABLE_AUTH === '1') {
    const remote = req.socket?.remoteAddress || '';
    if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
      return true;
    }
  }

  const verify = getAuthVerifier();
  const header = req.headers['authorization'] || '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/.exec(header);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx >= 0) {
      // Username is ignored — single-tenant tool. Only the password matters.
      const pw = decoded.slice(colonIdx + 1);
      if (verify(pw)) return true;
    }
  }

  res.writeHead(401, {
    'www-authenticate': 'Basic realm="autopg console"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(
    'autopg console requires authentication.\n' +
      'Username: any (e.g. "admin")\n' +
      'Password: see the value printed by `autopg install` or run `autopg auth rotate-admin-password`.\n',
  );
  return false;
}

function createHandler(ctx = {}) {
  const consoleRoot = ctx.consoleRoot || resolveConsoleRoot();
  return function handler(req, res) {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (!requireAuth(req, res)) return;

    if (url.startsWith('/api/')) {
      if (url === '/api/settings' && method === 'GET') return handleGetSettings(req, res);
      if (url === '/api/settings' && method === 'PUT') return handlePutSettings(req, res);
      if (url === '/api/restart' && method === 'POST') return handlePostRestart(req, res, ctx);
      if (url === '/api/status' && method === 'GET') return handleGetStatus(req, res, ctx);
      if (url === '/api/stats' && method === 'GET') return handleGetStats(req, res);
      if (url === '/api/data-dir' && method === 'POST') return handlePostDataDir(req, res, ctx);
      // Per-screen GET endpoints (v2.2.5). Each screen owns its own route
      // so the UI can request narrow data and bypass the catch-all
      // /api/settings. Stubs ship with a `screen` + `status: 'coming-soon'`
      // shape; real implementations land in v2.3.
      const screenMatch = method === 'GET' ? /^\/api\/screens\/([a-z0-9-]+)$/.exec(url) : null;
      if (screenMatch) return handleGetScreen(req, res, screenMatch[1]);
      sendError(res, 404, 'NOT_FOUND', `${method} ${url}`);
      return;
    }

    // Non-API → static file, GET/HEAD only.
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    handleStatic(req, res, consoleRoot);
  };
}

/**
 * Open a URL in the user's default browser. Best-effort: a failure is
 * logged and the server keeps running. Operators can always copy the
 * URL out of the boot banner.
 */
function openBrowser(url) {
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stderr.write(`autopg: could not auto-open browser; visit ${url}\n`);
    });
    child.unref();
  } catch {
    process.stderr.write(`autopg: could not auto-open browser; visit ${url}\n`);
  }
}

/**
 * Boot the UI server. Resolves to `{ server, port, close }` so callers
 * (and tests) can shut it down deterministically.
 *
 * In CLI mode, callers should pass `wireSignals: true` so SIGINT/SIGTERM
 * stop the server cleanly and the process exits 0.
 */
async function startServer({ args = [], scriptPath, consoleRoot, wireSignals = false, openInBrowser = openBrowser } = {}) {
  const opts = parseArgs(args);
  const handler = createHandler({ scriptPath, consoleRoot });
  const server = http.createServer(handler);
  const { port } = await listenWithFallback(server, opts.host, opts.port);

  const url = `http://${opts.host}:${port}`;
  process.stdout.write(`autopg ui: listening on ${url}\n`);
  process.stdout.write(`autopg ui: settings file is ${getSettingsPath()}\n`);

  if (!opts.noOpen) {
    openInBrowser(url);
  }

  function close() {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  if (wireSignals) {
    const stop = async (sig) => {
      process.stdout.write(`\nautopg ui: ${sig} received, shutting down\n`);
      await close();
      process.exit(0);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }

  return { server, port, url, close };
}

/**
 * CLI dispatch entry. Boots the server and parks until SIGINT/SIGTERM.
 * Always returns 0 — the signal handlers exit the process directly.
 */
async function dispatch(args = [], ctx = {}) {
  try {
    await startServer({
      args,
      scriptPath: ctx.scriptPath,
      consoleRoot: ctx.consoleRoot,
      wireSignals: true,
    });
  } catch (err) {
    process.stderr.write(`autopg ui: ${err.message ?? err}\n`);
    return 1;
  }
  // Park forever — signal handlers terminate the process.
  return new Promise(() => {});
}

module.exports = {
  dispatch,
  startServer,
  createHandler,
  parseArgs,
  resolveConsoleRoot,
  // Test surface
  _internals: {
    listenWithFallback,
    safeJoin,
    deepMergePlain,
    handleGetSettings,
    handlePutSettings,
    handlePostRestart,
    handleGetStatus,
    openBrowser,
    PORT_RANGE_START,
    PORT_RANGE_END,
  },
};
