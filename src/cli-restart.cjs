/**
 * `autopg restart` (also reachable via `pgserve restart`).
 *
 * Behavior:
 *   - If pm2 is supervising the `pgserve` process → `pm2 restart pgserve`.
 *     This is the production path: pm2 owns the lifecycle, sending it a
 *     restart bumps the supervised counter and respects the hardened
 *     defaults registered at install time.
 *   - Otherwise → read the daemon's pidfile, SIGTERM, wait for exit, then
 *     respawn via `bin/pgserve-wrapper.cjs daemon`. Detached so the
 *     respawn outlives this CLI process.
 *
 * Exit codes:
 *   0 - restart issued (pm2 path) or respawn started (local path)
 *   1 - pm2 restart failed, or respawn could not start, or the daemon
 *       didn't honor SIGTERM within the timeout
 *
 * Why pm2 wins when present: a supervised process restarted via the local
 * SIGTERM path would race pm2's own restart loop and double-fire (pm2
 * relaunches as soon as it sees the exit, then we relaunch again). The
 * pm2 jlist probe is the authoritative gate.
 */

'use strict';

const { spawnSync, spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PM2_PROCESS_NAME = 'pgserve';
const SIGTERM_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/**
 * Mirror of `resolvePidLockPath` from src/daemon.js (ESM). Inlined here
 * because cli-restart.cjs is CJS and we don't want to pull in dynamic
 * import for a 3-line path resolver. The two MUST stay in sync.
 */
function resolveControlSocketDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : '/tmp';
  return path.join(base, 'pgserve');
}

function resolvePidLockPath() {
  return path.join(resolveControlSocketDir(), 'pgserve.pid');
}

/**
 * `pm2 jlist` probe. Returns the registered process object or null.
 * Mirrors cli-install's helper but runs without the install ctx —
 * we don't need anything other than the process name.
 */
function pm2GetProcess(name = PM2_PROCESS_NAME) {
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
    execFileSync('pm2', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath) {
  if (!fs.existsSync(pidPath)) return null;
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Synchronously wait until the pidfile is gone (the daemon's graceful
 * shutdown path removes it). We don't also require !isAlive because the
 * pid may briefly be a zombie until the parent reaps it — the pidfile
 * being absent is the daemon's "I'm clean" signal, matching the existing
 * `pgserve daemon stop` flow in src/daemon.js.
 */
function waitForExit(pid, pidPath, timeoutMs = SIGTERM_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(pidPath)) return true;
    sleepBlocking(POLL_INTERVAL_MS);
  }
  return false;
}

function sleepBlocking(ms) {
  // Atomics.wait is a portable blocking sleep — node 16+ supports it on
  // a SharedArrayBuffer-backed Int32Array. No Bun dependency.
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, ms);
  } catch {
    // Fall back to a busy spin on platforms that don't allow Atomics.wait
    // on the main thread (rare). Acceptable here — only invoked at most
    // once per ~100ms inside a CLI command.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function fail(message) {
  process.stderr.write(`autopg: ${message}\n`);
  return 1;
}

function ok(message) {
  process.stdout.write(`autopg: ${message}\n`);
  return 0;
}

/**
 * Pm2-supervised path. `pm2 restart pgserve` is the canonical operator
 * action — pm2 increments its own restart counter and respects all the
 * hardening flags registered at install time.
 */
function restartViaPm2() {
  const result = spawnSync('pm2', ['restart', PM2_PROCESS_NAME], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    return fail(`pm2 restart failed (exit ${result.status})`);
  }
  return ok(`restarted via pm2 (process "${PM2_PROCESS_NAME}")`);
}

/**
 * Local-respawn path. Reads the daemon pidfile, SIGTERMs, waits, then
 * respawns the daemon detached so it survives this CLI process exiting.
 *
 * `scriptPath` is the path to bin/pgserve-wrapper.cjs (resolved by the
 * dispatcher's ctx so the test surface can inject a stub binary).
 */
function restartLocally({ scriptPath, env = process.env } = {}) {
  const pidPath = resolvePidLockPath();
  const pid = readPid(pidPath);

  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return fail(`failed to signal pid ${pid}: ${err.message}`);
    }
    if (!waitForExit(pid, pidPath)) {
      return fail(`pid ${pid} did not exit within ${SIGTERM_TIMEOUT_MS}ms`);
    }
  }

  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return fail(`cannot respawn: wrapper script not found at ${scriptPath}`);
  }

  // Spawn detached so the daemon outlives this CLI.
  const child = spawn(process.execPath, [scriptPath, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  return ok(`respawned daemon (pid ${child.pid})`);
}

/**
 * Entry point. `ctx.scriptPath` is the path to `bin/pgserve-wrapper.cjs`
 * (so the local respawn can re-enter the wrapper to start the daemon).
 *
 * `ctx.pm2IsAvailable` and `ctx.pm2GetProcess` are dependency-injection
 * hooks for tests — production callers omit them and the module-level
 * helpers (which shell out to the real `pm2` binary) are used.
 */
function dispatch(_args = [], ctx = {}) {
  const isAvailable = ctx.pm2IsAvailable || pm2IsAvailable;
  const getProcess = ctx.pm2GetProcess || pm2GetProcess;
  const restartFn = ctx.restartViaPm2 || restartViaPm2;
  if (isAvailable() && getProcess(PM2_PROCESS_NAME)) {
    return restartFn();
  }
  return restartLocally({ scriptPath: ctx.scriptPath });
}

module.exports = {
  dispatch,
  // Test surface
  _internals: {
    pm2GetProcess,
    pm2IsAvailable,
    readPid,
    isAlive,
    waitForExit,
    resolvePidLockPath,
    restartViaPm2,
    restartLocally,
    PM2_PROCESS_NAME,
    SIGTERM_TIMEOUT_MS,
  },
};
