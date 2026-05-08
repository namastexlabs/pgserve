/**
 * Tests for `autopg serve` (alias for `pgserve postmaster`) — cutover G19.
 *
 * Locks the dual-transport binding contract:
 *   - UDS at `<socketDir>/.s.PGSQL.<port>` accepts TCP-style connections.
 *   - TCP at 127.0.0.1:<port> accepts connections.
 *   - `<socketDir>/runtime.json` exists post-greet with the cohort-locked
 *     shape (`socketDir`, `port`, `pid`, `autopgPid`, `schemaVersion: 1`)
 *     and **no `supervisor` key** — that field lives only in
 *     `~/.autopg/admin.json`.
 *   - SIGTERM removes `runtime.json` (graceful shutdown contract).
 *   - SIGKILL leaves `runtime.json` in place with a non-live `autopgPid`
 *     so consumers detect staleness via `process.kill(pid, 0)`.
 *
 * Strategy: spawn the real postmaster against a temp datadir on a non-
 * default port (65432) so it can't collide with a host postgres. The
 * embedded postgres binaries are installed via `bun install` in the
 * worktree's optional dep `@embedded-postgres/<platform>-<arch>`; on a
 * fresh worktree the test boots in a few seconds.
 */

import { test, expect, beforeAll, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POSTMASTER_BIN = path.join(REPO_ROOT, 'bin', 'postgres-server.js');

// Ephemeral test ports. Picked above the privileged range and well clear
// of common PG/proxy/dev ports. Each test owns a distinct port so a
// previous case's TIME_WAIT (or an orphan postgres backend after SIGKILL)
// can't false-fail the next one's bind.
const PORT_BIND     = 65432;
const PORT_RUNTIME  = 65433;
const PORT_SIGTERM  = 65434;
const PORT_SIGKILL  = 65435;

// 30s startup budget — embedded postgres initdb on a cold cache can take
// 5–8s on a slow CI host. We poll every 100ms; well under the budget on
// a warm cache.
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

let bunPath;

beforeAll(() => {
  // The postmaster entry point is ESM and uses Bun.spawn / Bun.SQL inside
  // PostgresManager — it MUST run under bun, not node. We resolve the bun
  // binary the same way the wrapper does (node_modules/.bin or the parent
  // env). `process.execPath` works when this test is invoked via `bun
  // test`, which it is per package.json.
  bunPath = process.execPath;
  if (!bunPath.endsWith('bun') && !bunPath.endsWith('bun.exe')) {
    throw new Error(
      `serve.test.js: expected to run under \`bun test\` (process.execPath="${bunPath}")`,
    );
  }
});

let tmpRoot;
let dataDir;
let socketDir;
let runtimeFile;
let proc;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-serve-'));
  dataDir = path.join(tmpRoot, 'data');
  socketDir = path.join(tmpRoot, 'sock');
  runtimeFile = path.join(socketDir, 'runtime.json');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  // Best-effort: SIGKILL anything still alive from a failed test before
  // we rm the tempdir so postgres doesn't keep writing into a deleted
  // path while the next test is running.
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  proc = null;
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function spawnPostmaster({ port, extraArgs = [] } = {}) {
  if (!Number.isInteger(port)) {
    throw new Error('spawnPostmaster: port is required (each test owns its port to avoid TIME_WAIT collision)');
  }
  const args = [
    POSTMASTER_BIN,
    'postmaster',
    '--port', String(port),
    '--data', dataDir,
    '--socket-dir', socketDir,
    '--log', 'warn',
    ...extraArgs,
  ];
  const child = spawn(bunPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.captureStreams = () => ({ stdout, stderr });
  return child;
}

async function tcpProbe(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function udsProbe(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ path: socketPath });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitForReady(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const sockPath = path.join(socketDir, `.s.PGSQL.${port}`);
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath) && await tcpProbe('127.0.0.1', port)) {
      return { ok: true, sockPath };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, sockPath };
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('autopg serve — dual-transport binding', () => {
  test('binds UDS at <socketDir>/.s.PGSQL.<port> AND TCP 127.0.0.1:<port>', async () => {
    proc = spawnPostmaster({ port: PORT_BIND });
    const ready = await waitForReady(PORT_BIND);
    if (!ready.ok) {
      const { stdout, stderr } = proc.captureStreams();
      throw new Error(
        `postmaster did not become ready in ${STARTUP_TIMEOUT_MS}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    // UDS reachable — bound at <socketDir>/.s.PGSQL.<port>
    expect(fs.existsSync(ready.sockPath)).toBe(true);
    const udsOk = await udsProbe(ready.sockPath);
    expect(udsOk).toBe(true);

    // TCP reachable — bound at 127.0.0.1:<port>
    const tcpOk = await tcpProbe('127.0.0.1', PORT_BIND);
    expect(tcpOk).toBe(true);
  }, STARTUP_TIMEOUT_MS + 5000);
});

describe('autopg serve — runtime.json contract', () => {
  test('writes runtime.json after greet with the cohort-locked shape', async () => {
    proc = spawnPostmaster({ port: PORT_RUNTIME });
    const ready = await waitForReady(PORT_RUNTIME);
    expect(ready.ok).toBe(true);

    // runtime.json appears after the postmaster greets healthy. Poll
    // briefly to avoid racing a fast postmaster with the test thread.
    let raw;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(runtimeFile)) {
        raw = fs.readFileSync(runtimeFile, 'utf8');
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(raw).toBeDefined();

    const record = JSON.parse(raw);

    // Required fields, all present, all of the right shape.
    expect(record.socketDir).toBe(socketDir);
    expect(record.port).toBe(PORT_RUNTIME);
    expect(Number.isInteger(record.pid)).toBe(true);
    expect(record.pid).toBeGreaterThan(0);
    expect(Number.isInteger(record.autopgPid)).toBe(true);
    expect(record.autopgPid).toBeGreaterThan(0);
    expect(record.schemaVersion).toBe(1);

    // The autopgPid points at our spawned wrapper, not some random pid.
    expect(record.autopgPid).toBe(proc.pid);

    // Cohort contract: NO `supervisor` field. That key lives only in
    // `~/.autopg/admin.json`. Mixing them invites desync the moment the
    // postmaster restarts under a new pid.
    expect(Object.prototype.hasOwnProperty.call(record, 'supervisor')).toBe(false);
  }, STARTUP_TIMEOUT_MS + 5000);
});

describe('autopg serve — graceful shutdown removes runtime.json', () => {
  test('SIGTERM clears <socketDir>/runtime.json', async () => {
    proc = spawnPostmaster({ port: PORT_SIGTERM });
    const ready = await waitForReady(PORT_SIGTERM);
    expect(ready.ok).toBe(true);

    // Wait for runtime.json to land before signalling — otherwise the
    // shutdown path can race the writer and we'd see a missing file for
    // the wrong reason.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !fs.existsSync(runtimeFile)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(runtimeFile)).toBe(true);

    proc.kill('SIGTERM');
    const exit = await waitForExit(proc, 15_000);
    expect(exit.code).toBe(0);

    // After graceful shutdown the runtime discovery file is gone — fresh
    // consumers see "no live socket" immediately, no pid-probe needed.
    expect(fs.existsSync(runtimeFile)).toBe(false);
  }, STARTUP_TIMEOUT_MS + 20_000);
});

describe('autopg serve — crash leaves stale runtime.json', () => {
  test('SIGKILL leaves runtime.json with a non-live autopgPid', async () => {
    proc = spawnPostmaster({ port: PORT_SIGKILL });
    const ready = await waitForReady(PORT_SIGKILL);
    expect(ready.ok).toBe(true);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !fs.existsSync(runtimeFile)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fs.existsSync(runtimeFile)).toBe(true);
    const recordBefore = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));

    // SIGKILL — no chance to clean up. Mirrors a hard crash.
    const killedPid = proc.pid;
    proc.kill('SIGKILL');
    await waitForExit(proc, 5000);

    // File is still there; the recorded pid is no longer alive.
    expect(fs.existsSync(runtimeFile)).toBe(true);
    const recordAfter = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    expect(recordAfter.autopgPid).toBe(killedPid);
    expect(recordAfter).toEqual(recordBefore);

    // Liveness probe via process.kill(pid, 0) — ESRCH means the pid is
    // gone. Wrap so the test asserts the error path; if the process is
    // somehow still alive the assertion fails loudly.
    let alive = false;
    try {
      process.kill(recordAfter.autopgPid, 0);
      alive = true;
    } catch (err) {
      // ESRCH is the expected outcome; EPERM would mean the pid is alive
      // under another uid (impossible here, the wrapper is our child).
      expect(err.code).toBe('ESRCH');
    }
    expect(alive).toBe(false);
  }, STARTUP_TIMEOUT_MS + 20_000);
});
