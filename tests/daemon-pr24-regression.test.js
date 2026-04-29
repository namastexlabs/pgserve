/**
 * PR #24 regression tests for the v2 daemon.
 *
 * The daemon (src/daemon.js) shares a PostgresManager lifecycle with the
 * v1 router (src/router.js). PR #24's fixes for issue #24 (stale socketDir
 * leaks across stop/start cycles) must remain in force after the v2 cut.
 *
 * Coverage:
 *   1. PostgresManager.stop() nulls socketDir/databaseDir.
 *   2. start() + stop() + start() yields a fresh socketDir (no leak).
 *   3. Double start() is a no-op (re-entry guard).
 *   4. Daemon mode does NOT introduce a new socketDir leak path under
 *      abnormal exit (kill -9): orphaned socket file + pid lock are cleaned
 *      up by the next `PgserveDaemon.start()` boot via stale-pid detection.
 */

import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { PostgresManager } from '../src/postgres.js';
import { createLogger } from '../src/logger.js';
import {
  PgserveDaemon,
  acquirePidLock,
  resolveControlSocketPath,
  resolvePidLockPath,
  isProcessAlive,
} from '../src/daemon.js';

function silentLogger() {
  return createLogger({ level: 'warn' });
}

// Each test uses a unique controlSocketDir under tmp so concurrent runs
// (and the existing host's real /run/user/<uid>/pgserve) cannot collide.
function makeDaemonDirs(tag) {
  return fs.mkdtempSync(path.join('/tmp', `pgs-${tag}-`));
}

describe('PR #24 regression — PostgresManager lifecycle', () => {
  test('stop() nulls socketDir/databaseDir', async () => {
    const pg = new PostgresManager({ port: 16001, logger: silentLogger() });
    await pg.start();
    expect(pg.socketDir).not.toBeNull();
    expect(fs.existsSync(pg.socketDir)).toBe(true);
    const stale = pg.socketDir;

    await pg.stop();

    expect(pg.socketDir).toBeNull();
    expect(pg.databaseDir).toBeNull();
    expect(pg.getSocketPath()).toBeNull();
    expect(fs.existsSync(stale)).toBe(false);
  });

  test('start()+stop()+start() yields fresh socketDir, no leak', async () => {
    const pg = new PostgresManager({ port: 16002, logger: silentLogger() });

    await pg.start();
    const dirA = pg.socketDir;
    expect(dirA).not.toBeNull();

    await pg.stop();
    expect(pg.socketDir).toBeNull();

    await pg.start();
    const dirB = pg.socketDir;
    expect(dirB).not.toBeNull();
    expect(dirB).not.toBe(dirA);
    expect(fs.existsSync(dirB)).toBe(true);
    // Old dir must be gone; PR #24 guarantees no leak across cycles.
    expect(fs.existsSync(dirA)).toBe(false);

    await pg.stop();
  });

  test('double start() is a no-op (re-entry guard preserved)', async () => {
    const pg = new PostgresManager({ port: 16003, logger: silentLogger() });
    await pg.start();
    const before = pg.socketDir;

    const result = await pg.start();
    expect(result).toBe(pg);
    expect(pg.socketDir).toBe(before);

    await pg.stop();
  });
});

describe('PR #24 regression — daemon does not leak under abnormal exit', () => {
  test('stale pid lock + orphaned socket are cleaned up by next daemon boot', async () => {
    const dir = makeDaemonDirs('stale');
    const socketPath = resolveControlSocketPath(dir);
    const pidLockPath = resolvePidLockPath(dir);

    // Simulate kill -9: write a pid file pointing at a guaranteed-dead pid
    // and create a fake stale socket file beside it. PID 1 is always alive
    // on Unix, so we manufacture a dead one by reading max_pid + 1 (Linux)
    // or just using a high value not currently in use.
    const deadPid = pickDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    fs.writeFileSync(pidLockPath, String(deadPid), { mode: 0o600 });
    fs.writeFileSync(socketPath, ''); // stand-in for an orphaned socket file
    expect(fs.existsSync(pidLockPath)).toBe(true);
    expect(fs.existsSync(socketPath)).toBe(true);

    const lock = acquirePidLock({
      pidLockPath,
      socketPath,
      logger: silentLogger(),
    });
    expect(lock.acquired).toBe(true);

    // The lock file now belongs to *us* (this test's process pid), and the
    // orphaned socket placeholder must have been removed during stale-pid
    // cleanup so the daemon can bind a fresh socket on the same path.
    expect(fs.existsSync(pidLockPath)).toBe(true);
    expect(fs.readFileSync(pidLockPath, 'utf8').trim()).toBe(String(process.pid));
    expect(fs.existsSync(socketPath)).toBe(false);

    // Cleanup the test's lock so we don't leak between tests.
    fs.unlinkSync(pidLockPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('PgserveDaemon.start refuses second invocation while first is alive', async () => {
    const dir = makeDaemonDirs('singleton');
    const d1 = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16010,
      logger: silentLogger(),
    });
    await d1.start();

    const d2 = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16011,
      logger: silentLogger(),
    });

    let captured;
    try {
      await d2.start();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.code).toBe('EALREADYRUNNING');
    expect(captured.pid).toBe(process.pid);

    await d1.stop();
    expect(fs.existsSync(d1.controlSocketPath)).toBe(false);
    expect(fs.existsSync(d1.pidLockPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('PgserveDaemon.stop unlinks both socket and pid lock', async () => {
    const dir = makeDaemonDirs('cleanup');
    const d = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16020,
      logger: silentLogger(),
    });
    await d.start();
    expect(fs.existsSync(d.controlSocketPath)).toBe(true);
    expect(fs.existsSync(d.pidLockPath)).toBe(true);

    await d.stop();
    expect(fs.existsSync(d.controlSocketPath)).toBe(false);
    expect(fs.existsSync(d.pidLockPath)).toBe(false);

    // PR #24 invariant carries through: PostgresManager nulled its paths.
    expect(d.pgManager.socketDir).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Pick a pid that is reasonably guaranteed not to be alive. We try a high
 * pid first (most kernels recycle low pids), then walk down until we find
 * one that is dead. As a final fallback we use 999999.
 */
function pickDeadPid() {
  const candidates = [987654, 765432, 543210, 321098, 109876];
  for (const pid of candidates) {
    if (!isProcessAlive(pid)) return pid;
  }
  return 999999;
}
