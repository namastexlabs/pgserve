/**
 * Tests for the gc audit log writer (singleton G3 gc foundation).
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  writeGcAudit,
  readGcAuditDay,
  getAuditDir,
  getAuditFilePath,
  AUDIT_FILE_MODE,
  AUDIT_DIR_MODE,
  __testInternals,
} from '../../src/gc/audit-log.js';

let homeDir;
beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-audit-test-'));
});
afterEach(() => {
  if (homeDir && fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('paths', () => {
  test('getAuditDir is ~/.pgserve/audit', () => {
    expect(getAuditDir({ homeDir })).toBe(path.join(homeDir, '.pgserve', 'audit'));
  });

  test('getAuditFilePath uses UTC date in YYYY-MM-DD shape', () => {
    const file = getAuditFilePath({ homeDir, date: new Date('2026-05-08T22:30:00.000Z') });
    expect(file).toBe(path.join(homeDir, '.pgserve', 'audit', 'gc-2026-05-08.log'));
  });

  test('getAuditFilePath uses UTC date even when local date differs', () => {
    // 2026-05-08 23:00 UTC = 2026-05-09 02:00 in UTC+3
    const file = getAuditFilePath({ homeDir, date: new Date('2026-05-08T23:00:00.000Z') });
    expect(path.basename(file)).toBe('gc-2026-05-08.log');
  });
});

describe('writeGcAudit', () => {
  test('tightens dir mode to 0700 even when the dir already exists with a looser mode (PR #90 review MEDIUM)', () => {
    // Pre-create the dir with a loose umask, simulating an older gc
    // version or a manual `mkdir -p`.
    const dir = path.join(homeDir, '.pgserve', 'audit');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect((fs.statSync(dir).mode & 0o777)).toBe(0o755);
    writeGcAudit({ action: 'start' }, { homeDir });
    expect((fs.statSync(dir).mode & 0o777)).toBe(AUDIT_DIR_MODE);
  });

  test('appends one JSON-line per call and creates the dir 0700 / file 0600', () => {
    writeGcAudit({ action: 'drop', fingerprint: 'fp1', database: 'db1', reason: 'missing_db' }, { homeDir });
    writeGcAudit({ action: 'skip', fingerprint: 'fp2', database: 'db2', reason: 'active' }, { homeDir });
    const file = getAuditFilePath({ homeDir });
    const stat = fs.statSync(file);
    expect((stat.mode & 0o777)).toBe(AUDIT_FILE_MODE);
    const dirStat = fs.statSync(getAuditDir({ homeDir }));
    expect((dirStat.mode & 0o777)).toBe(AUDIT_DIR_MODE);
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBe(2);
    const e0 = JSON.parse(lines[0]);
    const e1 = JSON.parse(lines[1]);
    expect(e0.action).toBe('drop');
    expect(e0.database).toBe('db1');
    expect(e1.action).toBe('skip');
    expect(typeof e0.ts).toBe('string');
  });

  test('returns the line that was written (without the trailing newline)', () => {
    const line = writeGcAudit({ action: 'finish', detail: 'all done' }, { homeDir });
    expect(line.endsWith('\n')).toBe(false);
    expect(JSON.parse(line).action).toBe('finish');
  });

  test('ts override is preserved verbatim (correlation-id use case)', () => {
    writeGcAudit({ ts: 'corr-12345', action: 'drop', database: 'db1' }, { homeDir });
    const events = readGcAuditDay({ homeDir });
    expect(events[0].ts).toBe('corr-12345');
  });

  test('non-string ts (undefined / number / Date) does NOT silently overwrite the generated ISO ts (PR #90 review HIGH)', () => {
    writeGcAudit({ action: 'drop', database: 'db_undef', ts: undefined }, { homeDir });
    writeGcAudit({ action: 'drop', database: 'db_num', ts: 12345 }, { homeDir });
    writeGcAudit({ action: 'drop', database: 'db_date', ts: new Date('2026-05-08T01:02:03.000Z') }, { homeDir });
    const events = readGcAuditDay({ homeDir });
    // Each event must end up with a string ts that parses as an ISO date.
    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(e.ts.length).toBeGreaterThan(0);
      // Must parse as a valid date — defends against the previous bug
      // where a number (12345) made it through and broke jq filters.
      expect(Number.isFinite(Date.parse(e.ts))).toBe(true);
    }
  });

  test('rejects an event without an action', () => {
    expect(() => writeGcAudit({ database: 'db' }, { homeDir })).toThrow(TypeError);
    expect(() => writeGcAudit(null, { homeDir })).toThrow(TypeError);
  });
});

describe('readGcAuditDay', () => {
  test('returns [] when the file does not exist yet', () => {
    expect(readGcAuditDay({ homeDir })).toEqual([]);
  });

  test('parses well-formed lines and tags malformed ones', () => {
    const dir = getAuditDir({ homeDir });
    fs.mkdirSync(dir, { recursive: true });
    const file = getAuditFilePath({ homeDir });
    fs.writeFileSync(
      file,
      '{"action":"drop","database":"db1"}\n' +
        'this-is-not-json\n' +
        '{"action":"skip","database":"db2"}\n',
    );
    const events = readGcAuditDay({ homeDir });
    expect(events.length).toBe(3);
    expect(events[0].action).toBe('drop');
    expect(events[1].malformed).toBe(true);
    expect(events[1].raw).toBe('this-is-not-json');
    expect(events[2].action).toBe('skip');
  });

  test('reads the date the caller specifies (rotation across days)', () => {
    writeGcAudit({ action: 'drop', database: 'db1' }, {
      homeDir,
      date: new Date('2026-05-07T12:00:00Z'),
    });
    writeGcAudit({ action: 'drop', database: 'db2' }, {
      homeDir,
      date: new Date('2026-05-08T12:00:00Z'),
    });
    const day7 = readGcAuditDay({ homeDir, date: new Date('2026-05-07T18:00:00Z') });
    const day8 = readGcAuditDay({ homeDir, date: new Date('2026-05-08T18:00:00Z') });
    expect(day7.length).toBe(1);
    expect(day8.length).toBe(1);
    expect(day7[0].database).toBe('db1');
    expect(day8[0].database).toBe('db2');
  });
});

describe('formatUtcDate', () => {
  test('zero-pads month / day', () => {
    expect(__testInternals.formatUtcDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
  });

  test('rejects a non-Date input', () => {
    expect(() => __testInternals.formatUtcDate('2026-05-08')).toThrow(TypeError);
    expect(() => __testInternals.formatUtcDate(new Date('not-a-date'))).toThrow(TypeError);
  });
});
