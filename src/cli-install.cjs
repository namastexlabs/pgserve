/**
 * pgserve install / uninstall / status / url / port subcommands.
 *
 * Wave 1 of the canonical-pgserve-pm2-supervision wish (PR #55, issue #56).
 *
 * These subcommands let pgserve own its pm2 lifecycle. Other services that
 * need a Postgres connection (omni, genie, future) shell out to:
 *
 *     pgserve install        # idempotent, registers under pm2
 *     pgserve url            # postgres://localhost:8432/postgres
 *
 * instead of spinning up their own embedded pgserve. End-state: a single
 * shared pgserve under pm2 with hardened defaults, consumed by everyone.
 *
 * This module intentionally lives outside `bin/postgres-server.js` because
 * none of these subcommands need bun (or a running PG backend) — they are
 * filesystem + pm2 wrappers. Keeping them here means `pgserve install`
 * works even when bun isn't healthy yet (the wrapper's bun-probe would
 * otherwise block the install path).
 */

'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PM2_PROCESS_NAME = 'pgserve';
const DEFAULT_PORT = 8432;

// Console UI is auto-supervised under pm2 alongside the daemon since v2.2.3.
// The bundled SPA (console/dist/) is served on this port; operator-facing
// only, 127.0.0.1, no auth, no TLS — matches autopg's "single-user dev tool"
// posture. Opt-out with `autopg install --no-ui` for headless/CI hosts.
const UI_PM2_PROCESS_NAME = 'autopg-ui';
const DEFAULT_UI_PORT = 8433;
const UI_MAX_MEMORY = '256M';

/**
 * Hardening defaults — tuned for production-grade elasticity, NOT
 * the toy-machine values an initial draft of the wish carried.
 *
 * Earlier draft pinned `maxMemory: 1G` and `maxRestarts: 10`. The
 * operator who reviewed PR #57 caught both as dangerously small for
 * Postgres realistically:
 *   - 1G OOM-kills pgserve under modest load (shared_buffers + autovacuum
 *     workers + connection backends easily exceed 1G with a working set
 *     of any size).
 *   - 10 restart cap burns through during transient flakes (NATS reconnect
 *     loop, parent-process restart, host pressure spikes) before pm2
 *     gives up, leaving the operator with a stopped service in the
 *     morning.
 *
 * Revised defaults:
 *   - 4G memory ceiling — covers realistic load while still bounded so
 *     a runaway query can't eat the host.
 *   - 50 max restarts. Earlier drafts paired this with `--min-uptime` to
 *     only count rapid failures, but pm2 ≥ 6.0 dropped `--min-uptime` from
 *     the CLI surface (it survives only inside ecosystem files now). We
 *     keep the budget generous enough that occasional long-uptime crashes
 *     don't burn through it; if you observe restart-budget exhaustion
 *     from non-rapid crashes, raise `maxRestarts` rather than reintroducing
 *     `--min-uptime` (which would break install on pm2 6.x).
 *   - Exponential backoff on repeated failures (100ms → 60s) so we don't
 *     hammer on persistent issues.
 *   - 60s graceful shutdown window — Postgres needs time to flush WAL.
 *
 * Override at install time via env:
 *   PGSERVE_MAX_MEMORY=8G  pgserve install
 *
 * These mirror the values omni and genie will use for their own pm2
 * services. The constants are duplicated across repos (avoids a new
 * shared package) but the values are pinned in the wish.
 */
const HARDENED_DEFAULTS = {
  maxRestarts: 50,
  restartDelayMs: 4000,
  expBackoffRestartDelayMs: 100,
  // pm2 caps `--exp-backoff-restart-delay` ramp at the current backoff
  // doubling — practical max ~60s. Documented for operator clarity.
  expBackoffMaxMs: 60_000,
  maxMemory: process.env.PGSERVE_MAX_MEMORY || '4G',
  killTimeoutMs: 60_000,
  logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
};

/**
 * Resolve the config directory. AUTOPG_CONFIG_DIR (the new var) wins,
 * PGSERVE_CONFIG_DIR (the legacy var) is honored as a fall-through, and
 * `~/.autopg/` is the new default. The legacy default `~/.pgserve/` is
 * NOT consulted here — `settings-migrate.js` handles the one-shot copy.
 *
 * Soft-rename rule: AUTOPG_<X> beats PGSERVE_<X>. When only the legacy
 * env is set we still honor it but the loader emits a one-time
 * deprecation log via logger.warn (see settings-loader.js).
 */
function getConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR ||
    process.env.PGSERVE_CONFIG_DIR ||
    path.join(os.homedir(), '.autopg')
  );
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getLogsDir() {
  return path.join(getConfigDir(), 'logs');
}

function getDataDir() {
  return path.join(getConfigDir(), 'data');
}

function readConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = `${getConfigPath()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(tmp, getConfigPath());
}

/**
 * Run `pm2 jlist` and return the entry for our process, or null when not
 * registered. Returns null on any failure (pm2 missing, JSON parse error,
 * etc.) — callers should treat that as "not installed" rather than crash.
 */
function pm2GetProcess(name) {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = JSON.parse(out);
    return list.find((p) => p && p.name === name) || null;
  } catch {
    return null;
  }
}

function pm2IsAvailable() {
  try {
    execFileSync('pm2', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective supervision config — start from HARDENED_DEFAULTS,
 * overlay any values found in `~/.autopg/settings.json` `supervision`
 * section. Failures fall through to defaults silently so `pgserve install`
 * still works on a fresh machine before `autopg config init` has run.
 *
 * Precedence: defaults < settings.json < env (env wins via loadEffectiveConfig).
 */
function getEffectiveSupervision() {
  try {
    const { loadEffectiveConfig } = require('./settings-loader.cjs');
    const { settings } = loadEffectiveConfig();
    const sup = settings?.supervision || {};
    return {
      maxRestarts: sup.maxRestarts ?? HARDENED_DEFAULTS.maxRestarts,
      minUptimeMs: sup.minUptimeMs ?? HARDENED_DEFAULTS.minUptimeMs,
      restartDelayMs: sup.restartDelayMs ?? HARDENED_DEFAULTS.restartDelayMs,
      expBackoffRestartDelayMs: sup.expBackoffRestartDelayMs ?? HARDENED_DEFAULTS.expBackoffRestartDelayMs,
      expBackoffMaxMs: sup.expBackoffMaxMs ?? HARDENED_DEFAULTS.expBackoffMaxMs,
      maxMemory: sup.maxMemory ?? HARDENED_DEFAULTS.maxMemory,
      killTimeoutMs: sup.killTimeoutMs ?? HARDENED_DEFAULTS.killTimeoutMs,
      logDateFormat: sup.logDateFormat ?? HARDENED_DEFAULTS.logDateFormat,
    };
  } catch {
    return { ...HARDENED_DEFAULTS };
  }
}

function buildPm2StartArgs({ scriptPath, port, dataDir }) {
  const logs = {
    out: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-out.log`),
    error: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-error.log`),
  };
  const supervision = getEffectiveSupervision();
  return [
    'start',
    scriptPath,
    '--name',
    PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--max-restarts',
    String(supervision.maxRestarts),
    // NOTE: pm2 ≥ 6.0 dropped `--min-uptime` from the CLI surface — passing
    // it produces `error: unknown option --min-uptime` and aborts the
    // install. The flag still works inside an ecosystem file, but per the
    // canonical-pm2-supervision wish we keep `pgserve install` as a pure
    // CLI flow (no extra files for operators to manage). The trade-off is
    // that `--max-restarts` now counts every restart (rapid or not) rather
    // than only sub-`min_uptime` ones; the budget of 50 above is sized
    // accordingly.
    '--restart-delay',
    String(supervision.restartDelayMs),
    // Exponential backoff between successive failures: starts at 100ms,
    // doubles each crash, ramps to ~60s. Avoids hammering pm2 + the host
    // when the underlying issue is persistent.
    '--exp-backoff-restart-delay',
    String(supervision.expBackoffRestartDelayMs),
    '--max-memory-restart',
    supervision.maxMemory,
    '--kill-timeout',
    String(supervision.killTimeoutMs),
    '--log-date-format',
    supervision.logDateFormat,
    '--output',
    logs.out,
    '--error',
    logs.error,
    '--',
    // Foreground multi-tenant mode (`pgserve [options]`), NOT daemon mode.
    //
    // Daemon mode binds a unix control socket and requires libpq peers to
    // authenticate via a fingerprint+token handshake (`pgserve daemon
    // issue-token`). Downstream services that connect with a plain
    // `postgres://` URL (omni, genie, anything that doesn't speak the
    // fingerprint protocol) cannot reach a daemon-mode listener. We also
    // observed live: `pgserve install` was passing `--port` to the daemon
    // parser, which only accepts `--data | --ram | --log | --no-provision
    // | --listen | --pgvector` — every install attempt crashed with
    // `Unknown daemon option: --port` and pm2 burned its restart budget.
    //
    // Foreground mode (the default `pgserve [options]` invocation in
    // postgres-server.js) accepts `--port`, auto-provisions databases on
    // first connect, runs the cluster on multi-core hosts, and binds TCP
    // on `127.0.0.1:<port>` with no auth dance — exactly what canonical
    // pgserve consumers expect. Pass the same flags pgserve already
    // documents in its own `pgserve --help` output.
    '--port',
    String(port),
    '--data',
    dataDir,
    '--log',
    'warn',
  ];
}

function ensureLogsDir() {
  const dir = getLogsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function fail(message) {
  process.stderr.write(`pgserve: ${message}\n`);
  process.exit(1);
}

function note(message) {
  process.stderr.write(`pgserve: ${message}\n`);
}

function ok(message) {
  process.stdout.write(`pgserve: ${message}\n`);
}

/**
 * Resolve the autopg wrapper used to launch the UI under pm2. The wrapper
 * lives next to `postgres-server.js` (same `bin/` dir).
 */
function getUiBinPath(scriptPath) {
  return path.join(path.dirname(scriptPath), 'autopg-wrapper.cjs');
}

/**
 * pm2 start args for the UI process. Smaller memory cap than the daemon
 * (idle node http server, no postgres backend), shares the same restart
 * budget + exp-backoff as pgserve.
 */
function buildUiPm2StartArgs({ uiBinPath, uiPort }) {
  const logs = {
    out: path.join(getLogsDir(), `${UI_PM2_PROCESS_NAME}-out.log`),
    error: path.join(getLogsDir(), `${UI_PM2_PROCESS_NAME}-error.log`),
  };
  const supervision = getEffectiveSupervision();
  return [
    'start',
    uiBinPath,
    '--name',
    UI_PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--max-restarts',
    String(supervision.maxRestarts),
    '--restart-delay',
    String(supervision.restartDelayMs),
    '--exp-backoff-restart-delay',
    String(supervision.expBackoffRestartDelayMs),
    '--max-memory-restart',
    UI_MAX_MEMORY,
    '--kill-timeout',
    String(supervision.killTimeoutMs),
    '--log-date-format',
    supervision.logDateFormat,
    '--output',
    logs.out,
    '--error',
    logs.error,
    '--',
    'ui',
    '--no-open',
    '--port',
    String(uiPort),
  ];
}

/**
 * Register `autopg-ui` under pm2. Soft-fails: if pm2 is missing, the bin
 * is missing, or the spawn fails — log a note and return 0 anyway. The
 * daemon is the load-bearing process; the UI is convenience.
 */
function cmdInstallUi(ctx, options = {}) {
  if (!pm2IsAvailable()) {
    note('pm2 not found; skipping UI install (run `autopg ui` on demand)');
    return 0;
  }

  const existing = pm2GetProcess(UI_PM2_PROCESS_NAME);
  if (existing) {
    ok(`UI already installed (pm2 process "${UI_PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'})`);
    return 0;
  }

  const uiBinPath = getUiBinPath(ctx.scriptPath);
  if (!fs.existsSync(uiBinPath)) {
    note(`UI bin not found at ${uiBinPath}; skipping UI install`);
    return 0;
  }

  ensureLogsDir();
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;
  const pm2Args = buildUiPm2StartArgs({ uiBinPath, uiPort });
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    note(`UI install failed (exit ${result.status}); daemon is unaffected. Run \`autopg ui\` manually.`);
    return 0;
  }
  ok(`UI installed: pm2 process "${UI_PM2_PROCESS_NAME}" on http://127.0.0.1:${uiPort}`);
  return 0;
}

function cmdUninstallUi() {
  if (!pm2IsAvailable()) return 0;
  // Always attempt the delete — `pm2 delete <name>` is idempotent and
  // exits non-zero on a missing process, which is fine to swallow. This
  // is more robust than a pre-existence check against `pm2 jlist`, which
  // can lag the actual process state (or, in test stubs, return a
  // partial registry).
  const result = spawnSync('pm2', ['delete', UI_PM2_PROCESS_NAME], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    ok(`UI uninstalled (pm2 process "${UI_PM2_PROCESS_NAME}" removed)`);
  }
  return 0;
}

/**
 * `pgserve install [--port N] [--data PATH] [--no-ui] [--ui-port N]`
 *
 * Idempotent. When the process is already registered, prints a reuse line
 * and exits 0 without touching anything. Otherwise: writes `~/.pgserve/
 * config.json` (creating the dir if needed), then registers the process
 * under pm2 with the hardened defaults.
 *
 * Since v2.2.3: also auto-supervises the autopg console UI under pm2 as
 * `autopg-ui` (default port 8433). Opt out via `--no-ui`. The UI is a thin
 * http server bound to 127.0.0.1 — single-user dev tool, no auth, no TLS.
 *
 * `scriptPath` is the path to `bin/postgres-server.js` resolved by the
 * wrapper before this module is required (avoids re-resolving here).
 */
function cmdInstall(args, ctx) {
  if (!pm2IsAvailable()) {
    fail('pm2 not found in PATH. Install with: bun add -g pm2  (or npm i -g pm2)');
  }

  const port = parsePort(args) ?? readConfig()?.port ?? DEFAULT_PORT;
  const dataDir = parseDataDir(args) ?? readConfig()?.dataDir ?? getDataDir();

  const noUi = args.includes('--no-ui');
  const uiPort = parseUiPort(args) ?? DEFAULT_UI_PORT;

  // Idempotent: already-registered = no-op success. Still reconcile the UI
  // process so re-running `autopg install` after an upgrade picks up the UI
  // even on hosts where the daemon was registered pre-v2.2.3.
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (existing) {
    ok(`already installed (pm2 process "${PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'})`);
    // Refresh config in case install was re-run with new flags — but
    // don't tear down the live process. Operators wanting a port change
    // should `uninstall` then `install`.
    writeConfig({ port, dataDir, registeredAt: readConfig()?.registeredAt ?? new Date().toISOString() });
    if (!noUi) cmdInstallUi(ctx, { uiPort });
    return 0;
  }

  ensureLogsDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const pm2Args = buildPm2StartArgs({ scriptPath: ctx.scriptPath, port, dataDir });
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 start failed (exit ${result.status}). Logs: ${getLogsDir()}/${PM2_PROCESS_NAME}-error.log`);
  }

  writeConfig({ port, dataDir, registeredAt: new Date().toISOString() });
  ok(`installed: pm2 process "${PM2_PROCESS_NAME}" on port ${port} (data: ${dataDir})`);
  ok(`url: postgres://localhost:${port}/postgres`);

  if (noUi) {
    note('--no-ui set; skipping console install. Run `autopg ui` on demand.');
  } else {
    cmdInstallUi(ctx, { uiPort });
  }
  return 0;
}

/**
 * `pgserve uninstall`
 *
 * Removes pgserve from pm2. Leaves the data directory and config file
 * intact — operator can `rm -rf ~/.pgserve` after they're satisfied no
 * downstream service still depends on the data.
 */
function cmdUninstall() {
  // Delete the daemon first — it's the load-bearing process and the order
  // of "what existed at uninstall start" is determined by the daemon's
  // pm2 registry, not the UI's. UI cleanup follows; soft-fails if absent.
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (!existing) {
    ok(`not registered under pm2 (nothing to uninstall)`);
    cmdUninstallUi();
    return 0;
  }
  const result = spawnSync('pm2', ['delete', PM2_PROCESS_NAME], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 delete failed (exit ${result.status})`);
  }
  ok(`uninstalled (pm2 process removed; data dir preserved at ${getDataDir()})`);
  cmdUninstallUi();
  return 0;
}

/**
 * `pgserve status [--json]`
 *
 * Reports both pm2 state and on-disk config. Exits 0 with status info
 * regardless of running/stopped — operators script around the JSON output.
 * Non-zero only when the config is missing entirely (i.e. pgserve was
 * never installed).
 */
function cmdStatus(args) {
  const json = args.includes('--json');
  const config = readConfig();
  if (!config) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
    } else {
      ok('not installed (run: pgserve install)');
    }
    return 1;
  }
  const proc = pm2GetProcess(PM2_PROCESS_NAME);
  const status = proc?.pm2_env?.status ?? 'stopped';
  const pid = proc?.pid ?? null;
  const uptimeMs = proc?.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null;
  const restarts = proc?.pm2_env?.restart_time ?? 0;

  const payload = {
    installed: true,
    name: PM2_PROCESS_NAME,
    status,
    pid,
    port: config.port,
    dataDir: config.dataDir,
    logsDir: getLogsDir(),
    url: `postgres://localhost:${config.port}/postgres`,
    uptimeMs,
    restarts,
    registeredAt: config.registeredAt,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`name        ${payload.name}\n`);
  process.stdout.write(`status      ${payload.status}${payload.pid ? ` (pid ${payload.pid})` : ''}\n`);
  process.stdout.write(`port        ${payload.port}\n`);
  process.stdout.write(`url         ${payload.url}\n`);
  process.stdout.write(`dataDir     ${payload.dataDir}\n`);
  process.stdout.write(`logsDir     ${payload.logsDir}\n`);
  if (payload.uptimeMs != null) {
    const sec = Math.floor(payload.uptimeMs / 1000);
    process.stdout.write(`uptime      ${sec}s\n`);
  }
  process.stdout.write(`restarts    ${payload.restarts}\n`);
  process.stdout.write(`registered  ${payload.registeredAt}\n`);
  return 0;
}

/**
 * `pgserve url`
 *
 * Discovery API. Prints the canonical connection string. Downstream
 * installers (genie install, omni install) call this to learn where to
 * connect, instead of hardcoding a port.
 */
function cmdUrl() {
  const config = readConfig();
  if (!config) {
    fail('not installed (run: pgserve install)');
  }
  process.stdout.write(`postgres://localhost:${config.port}/postgres\n`);
  return 0;
}

/** `pgserve port` — print the canonical port. */
function cmdPort() {
  const config = readConfig();
  if (!config) {
    fail('not installed (run: pgserve install)');
  }
  process.stdout.write(`${config.port}\n`);
  return 0;
}

function parsePort(args) {
  const i = args.indexOf('--port');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--port requires a value');
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid --port "${v}"`);
  return n;
}

function parseDataDir(args) {
  const i = args.indexOf('--data');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--data requires a value');
  return path.resolve(v);
}

function parseUiPort(args) {
  const i = args.indexOf('--ui-port');
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v) fail('--ui-port requires a value');
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid --ui-port "${v}"`);
  return n;
}

/**
 * One-shot migration check from `~/.pgserve/` → `~/.autopg/`. Runs once
 * per process at the top of dispatch() so every CLI entry point gets
 * the cutover. Fully best-effort: any failure is swallowed (we never
 * want migration to block an `autopg status` invocation).
 */
let _migrationChecked = false;
function ensureMigrationOnce() {
  if (_migrationChecked) return;
  _migrationChecked = true;
  try {
    const { migrateIfNeeded } = require('./settings-migrate.cjs');
    const result = migrateIfNeeded();
    if (result.migrated) {
      process.stderr.write(
        `autopg: migrated ${result.legacy} → ${result.fresh} (one-time)\n`,
      );
    }
  } catch {
    // Swallow — operator can re-run migration manually if needed.
  }
}

/**
 * Entry point invoked by the wrapper. Returns the exit code (or a Promise
 * for async subcommands such as `ui`). Throws on unknown subcommand so
 * the wrapper's normal flow can take over (the router treats any
 * non-recognized subcommand as "pass through to the postgres-server.js
 * dispatcher").
 *
 * `ctx.scriptPath` is the path to `bin/postgres-server.js` (used by
 * install for the pm2 entry point). For `restart` and `ui` we need the
 * wrapper script path instead — `ctx.wrapperPath`. The wrapper provides
 * both before calling dispatch.
 */
function dispatch(subcommand, args, ctx) {
  ensureMigrationOnce();
  switch (subcommand) {
    case 'install':
      return cmdInstall(args, ctx);
    case 'uninstall':
      return cmdUninstall();
    case 'status':
      return cmdStatus(args);
    case 'url':
      return cmdUrl();
    case 'port':
      return cmdPort();
    case 'upgrade': {
      const opts = {
        quiet: args.includes('--quiet'),
        dryRun: args.includes('--dry-run'),
        skipSteps: (() => {
          const idx = args.indexOf('--skip-steps');
          if (idx === -1) return [];
          return (args[idx + 1] || '').split(',').filter(Boolean);
        })(),
      };
      return import(require('node:path').join(__dirname, 'upgrade', 'index.js'))
        .then((mod) => mod.upgrade(opts))
        .then((r) => process.exit(r.ok ? 0 : 1));
    }
    case 'config': {
      const cfg = require('./cli-config.cjs');
      const [sub, ...rest] = args;
      return cfg.dispatch(sub, rest);
    }
    case 'restart': {
      const restart = require('./cli-restart.cjs');
      return restart.dispatch(args, { scriptPath: ctx.wrapperPath });
    }
    case 'ui': {
      const ui = require('./cli-ui.cjs');
      return ui.dispatch(args, { scriptPath: ctx.wrapperPath });
    }
    default:
      throw new Error(`pgserve: dispatch called with unknown subcommand "${subcommand}"`);
  }
}

module.exports = {
  // Public API for the wrapper.
  dispatch,
  // Test surface.
  _internals: {
    HARDENED_DEFAULTS,
    PM2_PROCESS_NAME,
    DEFAULT_PORT,
    getConfigDir,
    getConfigPath,
    getLogsDir,
    getDataDir,
    readConfig,
    writeConfig,
    buildPm2StartArgs,
    getEffectiveSupervision,
    parsePort,
    parseDataDir,
  },
};
