/**
 * Handshake watchdog: peers that connect and never complete the postgres
 * StartupMessage are forcibly closed past `PGSERVE_HANDSHAKE_DEADLINE_MS`.
 *
 * Regression coverage: pgserve#45 documented file-descriptor leak where
 * peers piled up indefinitely in `state.handshakeComplete=false`.
 *
 * The tests drive `_sweepStuckHandshakes()` directly via a synthetic
 * connection record. This avoids spawning a real postgres backend, which
 * is unnecessary when we only want to assert the sweep policy and timer
 * lifecycle.
 */

import { PgserveDaemon } from '../src/daemon.js';
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

function makeDaemon(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-watchdog-'));
  const daemon = new PgserveDaemon({
    baseDir: dir,
    logger: quietLogger(),
    enforcementDisabled: true,
    ...opts,
  });
  return { daemon, dir };
}

function fakeSocket() {
  const calls = [];
  return {
    end: () => { calls.push('end'); },
    pause: () => {}, resume: () => {}, write: () => 0,
    _calls: calls,
  };
}

test('handshakeDeadlineMs falls back to 30000 when env unset', () => {
  delete process.env.PGSERVE_HANDSHAKE_DEADLINE_MS;
  const { daemon, dir } = makeDaemon();
  expect(daemon.handshakeDeadlineMs).toBe(30000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('handshakeDeadlineMs honours PGSERVE_HANDSHAKE_DEADLINE_MS env', () => {
  process.env.PGSERVE_HANDSHAKE_DEADLINE_MS = '2000';
  try {
    const { daemon, dir } = makeDaemon();
    expect(daemon.handshakeDeadlineMs).toBe(2000);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    delete process.env.PGSERVE_HANDSHAKE_DEADLINE_MS;
  }
});

test('_sweepStuckHandshakes closes pre-handshake sockets past deadline', () => {
  const { daemon, dir } = makeDaemon({ handshakeDeadlineMs: 100 });
  const sock = fakeSocket();
  const stuckAt = Date.now() - 500; // older than 100ms deadline
  daemon.connections.add(sock);
  daemon.socketState.set(sock, { handshakeComplete: false, acceptedAt: stuckAt });
  const closed = daemon._sweepStuckHandshakes();
  expect(closed).toBe(1);
  expect(sock._calls).toContain('end');
  expect(daemon.connections.has(sock)).toBe(false);
  expect(daemon.socketState.has(sock)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_sweepStuckHandshakes leaves fresh pre-handshake sockets alone', () => {
  const { daemon, dir } = makeDaemon({ handshakeDeadlineMs: 30000 });
  const sock = fakeSocket();
  daemon.connections.add(sock);
  daemon.socketState.set(sock, { handshakeComplete: false, acceptedAt: Date.now() });
  const closed = daemon._sweepStuckHandshakes();
  expect(closed).toBe(0);
  expect(sock._calls).not.toContain('end');
  expect(daemon.connections.has(sock)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_sweepStuckHandshakes leaves completed-handshake sockets alone even past deadline', () => {
  const { daemon, dir } = makeDaemon({ handshakeDeadlineMs: 100 });
  const sock = fakeSocket();
  daemon.connections.add(sock);
  daemon.socketState.set(sock, { handshakeComplete: true, acceptedAt: Date.now() - 5000 });
  const closed = daemon._sweepStuckHandshakes();
  expect(closed).toBe(0);
  expect(sock._calls).not.toContain('end');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('handshakeSweepIntervalMs is bounded sensibly relative to deadline', () => {
  const { daemon, dir } = makeDaemon({
    handshakeDeadlineMs: 200,
    handshakeSweepIntervalMs: 50,
  });
  // Sweep interval cannot drop below 1s safety floor.
  expect(daemon.handshakeSweepIntervalMs).toBe(1000);
  fs.rmSync(dir, { recursive: true, force: true });
});
