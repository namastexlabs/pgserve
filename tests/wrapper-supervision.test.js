/**
 * Wrapper supervision: postgres backend death surfaces to the wrapper
 *
 * Verifies that:
 *  1. PostgresManager extends EventEmitter and emits `backendExited` when
 *     the postgres child exits.
 *  2. `expected: true` is reported when the exit was initiated by stop().
 *  3. `expected: false` is reported when the child was killed externally
 *     (the case the wrapper needs to react to per pgserve#45).
 *  4. PgserveDaemon re-emits `backendDiedUnexpectedly` only for unexpected
 *     exits, not for clean stop().
 *
 * Tests use the real Bun.spawn'd postgres binary via PostgresManager because
 * the supervision contract is end-to-end — a unit test with a mocked process
 * would prove only that the JS plumbing fires.
 */

import { PostgresManager } from '../src/postgres.js';
import { PgserveDaemon } from '../src/daemon.js';
import { EventEmitter } from 'events';
import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

function quietLogger() {
  return {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: () => quietLogger(),
  };
}

test('PostgresManager extends EventEmitter', () => {
  const mgr = new PostgresManager({});
  expect(mgr).toBeInstanceOf(EventEmitter);
});

test('PostgresManager emits backendExited with expected=true after stop()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-supv-stop-'));
  const mgr = new PostgresManager({ dataDir: dir, logger: quietLogger() });
  let event = null;
  mgr.on('backendExited', (info) => { event = info; });
  await mgr.start();
  await mgr.stop();
  // Give event loop a tick to flush exited.then handler if not already drained
  await new Promise((r) => setTimeout(r, 50));
  expect(event).not.toBeNull();
  expect(event.expected).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
}, 60000);

// External-SIGKILL integration coverage runs on Linux only. On macOS,
// Bun.spawn'd postgres reliably refuses to surface its `exited` promise
// within the test deadline when killed by SIGKILL — Bun's posix_spawn
// path on darwin holds parent reaping until grandchildren reap, which
// postgres never does fast enough for a deterministic test. The
// `expected=false` branch is still covered cross-platform by the
// daemon-level re-emit test below, which feeds a synthetic
// `backendExited` payload through a fake EventEmitter and bypasses the
// OS signal-handling variability entirely.
const linuxOnly = process.platform === 'linux' ? test : test.skip;
linuxOnly('PostgresManager emits backendExited with expected=false on external SIGKILL (linux)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-supv-kill-'));
  const mgr = new PostgresManager({ dataDir: dir, logger: quietLogger() });
  let event = null;
  mgr.on('backendExited', (info) => { event = info; });
  await mgr.start();
  const childPid = mgr.process?.pid;
  expect(childPid).toBeGreaterThan(0);
  // External kill — _stopping stays false, so the handler must mark unexpected
  process.kill(childPid, 'SIGKILL');
  // Wait for the exit handler to fire (max 3s)
  for (let i = 0; i < 60 && event === null; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(event).not.toBeNull();
  expect(event.expected).toBe(false);
  // Cleanup: paths were nulled by the unexpected-exit branch, so stop() is a no-op
  await mgr.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}, 60000);

test('PgserveDaemon re-emits backendDiedUnexpectedly only on unexpected exit', () => {
  // Pure plumbing test — synthesize PgserveDaemon and a fake pgManager that
  // is just an EventEmitter; verify the wiring.
  const fakePgManager = new EventEmitter();
  // PgserveDaemon constructor needs a baseDir; passing a tmp dir avoids
  // touching real config.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-supv-daemon-'));
  const daemon = new PgserveDaemon({
    baseDir: dir,
    logger: quietLogger(),
    pgManager: fakePgManager,
    enforcementDisabled: true,
  });
  const events = [];
  daemon.on('backendDiedUnexpectedly', (info) => events.push(info));

  fakePgManager.emit('backendExited', { code: 0, expected: true });
  expect(events).toHaveLength(0); // clean stop — no re-emit

  fakePgManager.emit('backendExited', { code: 137, expected: false });
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({ code: 137, expected: false });

  fs.rmSync(dir, { recursive: true, force: true });
});
