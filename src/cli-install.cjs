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

/**
 * Hardening defaults pinned in the wish (Decisions 4 & 5). These mirror
 * omni's `PM2_HARDENED_DEFAULTS` so the four pm2 services in the canonical
 * stack (pgserve / omni-api / omni-nats / genie-serve) all behave the same
 * under crash-loop and resource pressure.
 */
const HARDENED_DEFAULTS = {
  maxRestarts: 10,
  restartDelayMs: 5000,
  maxMemory: '1G',
  killTimeoutMs: 20000,
  logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
};

function getConfigDir() {
  return process.env.PGSERVE_CONFIG_DIR || path.join(os.homedir(), '.pgserve');
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

function buildPm2StartArgs({ scriptPath, port, dataDir }) {
  const logs = {
    out: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-out.log`),
    error: path.join(getLogsDir(), `${PM2_PROCESS_NAME}-error.log`),
  };
  return [
    'start',
    scriptPath,
    '--name',
    PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--max-restarts',
    String(HARDENED_DEFAULTS.maxRestarts),
    '--restart-delay',
    String(HARDENED_DEFAULTS.restartDelayMs),
    '--max-memory-restart',
    HARDENED_DEFAULTS.maxMemory,
    '--kill-timeout',
    String(HARDENED_DEFAULTS.killTimeoutMs),
    '--log-date-format',
    HARDENED_DEFAULTS.logDateFormat,
    '--output',
    logs.out,
    '--error',
    logs.error,
    '--',
    'daemon',
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
 * `pgserve install [--port N] [--data PATH]`
 *
 * Idempotent. When the process is already registered, prints a reuse line
 * and exits 0 without touching anything. Otherwise: writes `~/.pgserve/
 * config.json` (creating the dir if needed), then registers the process
 * under pm2 with the hardened defaults.
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

  // Idempotent: already-registered = no-op success.
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (existing) {
    ok(`already installed (pm2 process "${PM2_PROCESS_NAME}", status=${existing.pm2_env?.status ?? 'unknown'})`);
    // Refresh config in case install was re-run with new flags — but
    // don't tear down the live process. Operators wanting a port change
    // should `uninstall` then `install`.
    writeConfig({ port, dataDir, registeredAt: readConfig()?.registeredAt ?? new Date().toISOString() });
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
  const existing = pm2GetProcess(PM2_PROCESS_NAME);
  if (!existing) {
    ok(`not registered under pm2 (nothing to uninstall)`);
    return 0;
  }
  const result = spawnSync('pm2', ['delete', PM2_PROCESS_NAME], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`pm2 delete failed (exit ${result.status})`);
  }
  ok(`uninstalled (pm2 process removed; data dir preserved at ${getDataDir()})`);
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

/**
 * Entry point invoked by the wrapper. Returns the exit code. Throws on
 * unknown subcommand so the wrapper's normal flow can take over (the
 * router treats any non-recognized subcommand as "pass through to the
 * postgres-server.js dispatcher").
 */
function dispatch(subcommand, args, ctx) {
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
    parsePort,
    parseDataDir,
  },
};
