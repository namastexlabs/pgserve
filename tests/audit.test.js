/**
 * Tests for src/audit.js — JSONL writer with rotation + syslog target.
 *
 * Tests use temp dirs under /tmp; nothing touches the user's real
 * `~/.pgserve/audit.log`. The syslog test stubs `logger` via PATH so we
 * don't depend on (or pollute) the host's syslog daemon.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  audit,
  configureAudit,
  readAuditTarget,
  AUDIT_EVENTS,
  _internals,
} from '../src/audit.js';

let scratchDir;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-audit-test-'));
  configureAudit({
    logFile: path.join(scratchDir, 'audit.log'),
    target: 'file',
  });
});

afterEach(() => {
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch { /* noop */ }
});

test('audit() appends a JSON line per event', () => {
  audit(AUDIT_EVENTS.DB_CREATED, { fingerprint: 'abc123def456', db: 'app_demo_abc123def456' });
  audit(AUDIT_EVENTS.CONNECTION_ROUTED, { fingerprint: 'abc123def456', peer_pid: 1234 });

  const logFile = path.join(scratchDir, 'audit.log');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  expect(lines.length).toBe(2);
  const r1 = JSON.parse(lines[0]);
  expect(r1.event).toBe('db_created');
  expect(r1.fingerprint).toBe('abc123def456');
  expect(typeof r1.ts).toBe('string');
  expect(new Date(r1.ts).toString()).not.toBe('Invalid Date');

  const r2 = JSON.parse(lines[1]);
  expect(r2.event).toBe('connection_routed');
  expect(r2.peer_pid).toBe(1234);
});

test('audit() refuses unknown events', () => {
  expect(() => audit('definitely_not_a_real_event', {})).toThrow(/unknown event/);
});

test('audit() creates the parent directory if missing', () => {
  const nested = path.join(scratchDir, 'nested', 'sub', 'audit.log');
  audit(AUDIT_EVENTS.DB_CREATED, { fingerprint: 'a'.repeat(12) }, { logFile: nested });
  expect(fs.existsSync(nested)).toBe(true);
});

test('all v2.0 event names are exported (incl. Group 6 tcp_*)', () => {
  expect(Object.values(AUDIT_EVENTS).sort()).toEqual([
    'connection_denied_fingerprint_mismatch',
    'connection_routed',
    'db_created',
    'db_persist_honored',
    'db_reaped_liveness',
    'db_reaped_ttl',
    'enforcement_kill_switch_used',
    'tcp_token_denied',
    'tcp_token_issued',
    'tcp_token_used',
  ]);
});

test('rotation kicks in once existing file crosses 50 MB', () => {
  const logFile = path.join(scratchDir, 'audit.log');
  // Use a sparse file to simulate a 50 MB log without writing 50 MB.
  const fd = fs.openSync(logFile, 'w');
  fs.ftruncateSync(fd, _internals.ROTATE_THRESHOLD_BYTES);
  fs.closeSync(fd);

  audit(AUDIT_EVENTS.DB_CREATED, { fingerprint: 'r'.repeat(12) });

  // Original file rotated to .1, fresh file holds the new line.
  expect(fs.existsSync(`${logFile}.1`)).toBe(true);
  const fresh = fs.readFileSync(logFile, 'utf8');
  expect(fresh.trim().split('\n').length).toBe(1);
  expect(JSON.parse(fresh.trim()).event).toBe('db_created');

  // The rotated file is the original 50 MB sparse file.
  expect(fs.statSync(`${logFile}.1`).size).toBe(_internals.ROTATE_THRESHOLD_BYTES);
});

test('rotation cascades up to KEEP files and drops the eldest', () => {
  const logFile = path.join(scratchDir, 'audit.log');
  // Pre-populate audit.log.1 ... audit.log.5 with distinct markers.
  for (let i = 1; i <= _internals.ROTATE_KEEP; i++) {
    fs.writeFileSync(`${logFile}.${i}`, `slot-${i}\n`);
  }
  // And the live audit.log just under threshold.
  const fd = fs.openSync(logFile, 'w');
  fs.ftruncateSync(fd, _internals.ROTATE_THRESHOLD_BYTES);
  fs.closeSync(fd);

  audit(AUDIT_EVENTS.DB_CREATED, { fingerprint: 'q'.repeat(12) });

  // .5 (was "slot-5") dropped; .4 → .5; .3 → .4; .2 → .3; .1 → .2; live → .1.
  expect(fs.readFileSync(`${logFile}.5`, 'utf8').trim()).toBe('slot-4');
  expect(fs.readFileSync(`${logFile}.4`, 'utf8').trim()).toBe('slot-3');
  expect(fs.readFileSync(`${logFile}.3`, 'utf8').trim()).toBe('slot-2');
  expect(fs.readFileSync(`${logFile}.2`, 'utf8').trim()).toBe('slot-1');
  expect(fs.statSync(`${logFile}.1`).size).toBe(_internals.ROTATE_THRESHOLD_BYTES);
});

test('audit({target:"syslog"}) spawns logger -t pgserve-audit', async () => {
  // Stub `logger` by prepending a temp shim to PATH.
  const shimDir = path.join(scratchDir, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  const marker = path.join(scratchDir, 'logger-calls.txt');
  const shimPath = path.join(shimDir, 'logger');
  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
# Capture argv to a marker file so the test can verify the spawn.
printf '%s\\n' "$*" >> "${marker}"
`,
    { mode: 0o755 },
  );

  const oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;
  try {
    audit(
      AUDIT_EVENTS.CONNECTION_ROUTED,
      { fingerprint: 's'.repeat(12) },
      { target: 'syslog' },
    );
    // logger is spawned async; poll briefly for the marker.
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    expect(fs.existsSync(marker)).toBe(true);
    const contents = fs.readFileSync(marker, 'utf8');
    expect(contents).toContain('-t pgserve-audit');
    expect(contents).toContain('"event":"connection_routed"');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('audit({target:"syslog"}) swallows missing logger binary', () => {
  // Point PATH at an empty dir → `logger` cannot be found → no throw.
  const empty = path.join(scratchDir, 'empty');
  fs.mkdirSync(empty);
  const oldPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    expect(() =>
      audit(
        AUDIT_EVENTS.CONNECTION_ROUTED,
        { fingerprint: 'z'.repeat(12) },
        { target: 'syslog' },
      ),
    ).not.toThrow();
  } finally {
    process.env.PATH = oldPath;
  }
});

test('readAuditTarget reads pgserve.audit.target from package.json', () => {
  const pkgFile = path.join(scratchDir, 'package.json');
  fs.writeFileSync(
    pkgFile,
    JSON.stringify({ name: 'demo', pgserve: { audit: { target: 'syslog' } } }),
  );
  expect(readAuditTarget(pkgFile)).toBe('syslog');

  fs.writeFileSync(pkgFile, JSON.stringify({ name: 'demo' }));
  expect(readAuditTarget(pkgFile)).toBe('file');

  // Missing file → file (default).
  expect(readAuditTarget(path.join(scratchDir, 'missing.json'))).toBe('file');
});
