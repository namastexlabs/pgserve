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
      // Defense: still bind 127.0.0.1 unless explicitly opted out via env.
      // We accept --host for parity but ignore non-loopback values.
      const v = args[++i];
      if (v === '127.0.0.1' || v === 'localhost') {
        out.host = v;
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
  // src/ → repo root → console/
  return path.resolve(__dirname, '..', 'console');
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

function handleGetSettings(req, res) {
  try {
    const { settings, sources, etag, path: settingsPath } = loadEffectiveConfig();
    sendJson(res, 200, { settings, sources, etag, path: settingsPath });
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
function createHandler(ctx = {}) {
  const consoleRoot = ctx.consoleRoot || resolveConsoleRoot();
  return function handler(req, res) {
    const url = req.url || '/';
    const method = req.method || 'GET';

    if (url.startsWith('/api/')) {
      if (url === '/api/settings' && method === 'GET') return handleGetSettings(req, res);
      if (url === '/api/settings' && method === 'PUT') return handlePutSettings(req, res);
      if (url === '/api/restart' && method === 'POST') return handlePostRestart(req, res, ctx);
      if (url === '/api/status' && method === 'GET') return handleGetStatus(req, res, ctx);
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
