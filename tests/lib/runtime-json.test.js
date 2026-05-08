/**
 * Tests for `src/lib/runtime-json.js` — the `<socketDir>/runtime.json`
 * reader/writer used by `autopg serve` (cutover G19).
 *
 * These lock the cohort contract:
 *   - schema shape: { socketDir, port, pid, autopgPid, schemaVersion: 1 }
 *   - NO `supervisor` key (that field lives only in `~/.autopg/admin.json`)
 *   - reads return null on missing or malformed input — never throw
 *   - clearRuntimeJson is best-effort and idempotent
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RUNTIME_FILE_NAME,
  RUNTIME_FILE_MODE,
  RUNTIME_SCHEMA_VERSION,
  clearRuntimeJson,
  getRuntimeFilePath,
  isLiveRuntime,
  readRuntimeJson,
  writeRuntimeJson,
} from '../../src/lib/runtime-json.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-json-test-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeRecord(overrides = {}) {
  return {
    socketDir: tmpDir,
    port: 5432,
    pid: 12345,
    autopgPid: 12340,
    ...overrides,
  };
}

describe('exports', () => {
  test('exposes the cohort-locked constants', () => {
    expect(RUNTIME_FILE_NAME).toBe('runtime.json');
    expect(RUNTIME_FILE_MODE).toBe(0o644);
    expect(RUNTIME_SCHEMA_VERSION).toBe(1);
  });
});

describe('getRuntimeFilePath', () => {
  test('returns <socketDir>/runtime.json', () => {
    expect(getRuntimeFilePath('/run/user/1000/pgserve')).toBe('/run/user/1000/pgserve/runtime.json');
  });

  test('throws on empty / non-string socketDir', () => {
    expect(() => getRuntimeFilePath('')).toThrow(/non-empty string/);
    expect(() => getRuntimeFilePath(null)).toThrow(/non-empty string/);
    expect(() => getRuntimeFilePath(undefined)).toThrow(/non-empty string/);
  });
});

describe('writeRuntimeJson', () => {
  test('writes the cohort-locked shape with schemaVersion stamped', () => {
    const written = writeRuntimeJson(makeRecord());
    expect(written.schemaVersion).toBe(1);

    const onDisk = JSON.parse(fs.readFileSync(getRuntimeFilePath(tmpDir), 'utf8'));
    expect(onDisk).toEqual({
      socketDir: tmpDir,
      port: 5432,
      pid: 12345,
      autopgPid: 12340,
      schemaVersion: 1,
    });
  });

  test('mode is 0644 (operator-readable, no secrets)', () => {
    writeRuntimeJson(makeRecord());
    const stat = fs.statSync(getRuntimeFilePath(tmpDir));
    expect(stat.mode & 0o777).toBe(0o644);
  });

  test('refuses a record carrying a supervisor key', () => {
    expect(() =>
      writeRuntimeJson({ ...makeRecord(), supervisor: 'pm2' }),
    ).toThrow(/supervisor.*admin\.json/);
  });

  test('rejects malformed port', () => {
    expect(() => writeRuntimeJson(makeRecord({ port: 0 }))).toThrow(/port must be an integer in \[1, 65535\]/);
    expect(() => writeRuntimeJson(makeRecord({ port: 65536 }))).toThrow(/port must be an integer in \[1, 65535\]/);
    expect(() => writeRuntimeJson(makeRecord({ port: 'abc' }))).toThrow(/port must be an integer/);
  });

  test('rejects non-positive pids', () => {
    expect(() => writeRuntimeJson(makeRecord({ pid: 0 }))).toThrow(/pid must be a positive integer/);
    expect(() => writeRuntimeJson(makeRecord({ autopgPid: -1 }))).toThrow(/autopgPid must be a positive integer/);
  });

  test('creates the parent directory when missing', () => {
    const fresh = path.join(tmpDir, 'nested', 'sock');
    writeRuntimeJson(makeRecord({ socketDir: fresh }));
    expect(fs.existsSync(path.join(fresh, 'runtime.json'))).toBe(true);
  });

  test('writes atomically (no partial file lingering after error)', () => {
    // Sanity: tmp file pattern matches the documented atomic shape.
    writeRuntimeJson(makeRecord());
    const entries = fs.readdirSync(tmpDir);
    // Only the final file remains; the tmp shim was renamed.
    expect(entries.filter((f) => f.startsWith('runtime.json.tmp.'))).toEqual([]);
    expect(entries).toContain('runtime.json');
  });
});

describe('readRuntimeJson', () => {
  test('returns null when the file is missing', () => {
    expect(readRuntimeJson(tmpDir)).toBeNull();
  });

  test('returns null when JSON is malformed', () => {
    fs.writeFileSync(getRuntimeFilePath(tmpDir), 'not-json{', 'utf8');
    expect(readRuntimeJson(tmpDir)).toBeNull();
  });

  test('returns null when JSON parses to a non-object', () => {
    fs.writeFileSync(getRuntimeFilePath(tmpDir), '"a string"', 'utf8');
    expect(readRuntimeJson(tmpDir)).toBeNull();
    fs.writeFileSync(getRuntimeFilePath(tmpDir), '[1,2,3]', 'utf8');
    expect(readRuntimeJson(tmpDir)).toBeNull();
  });

  test('round-trips a valid record', () => {
    const written = writeRuntimeJson(makeRecord());
    expect(readRuntimeJson(tmpDir)).toEqual(written);
  });

  test('returns null on bad socketDir argument (never throws)', () => {
    expect(readRuntimeJson('')).toBeNull();
    expect(readRuntimeJson(null)).toBeNull();
    expect(readRuntimeJson(undefined)).toBeNull();
  });
});

describe('clearRuntimeJson', () => {
  test('removes the file when present', () => {
    writeRuntimeJson(makeRecord());
    expect(fs.existsSync(getRuntimeFilePath(tmpDir))).toBe(true);
    expect(clearRuntimeJson(tmpDir)).toBe(true);
    expect(fs.existsSync(getRuntimeFilePath(tmpDir))).toBe(false);
  });

  test('returns false when file is already gone (idempotent, never throws)', () => {
    expect(clearRuntimeJson(tmpDir)).toBe(false);
  });

  test('returns false on bad socketDir argument (never throws)', () => {
    expect(clearRuntimeJson('')).toBe(false);
    expect(clearRuntimeJson(null)).toBe(false);
  });
});

describe('isLiveRuntime', () => {
  test('returns true for the current process', () => {
    expect(isLiveRuntime({ autopgPid: process.pid })).toBe(true);
  });

  test('returns false for a pid that is definitely dead', () => {
    // Pick a pid that's so high it can't be in use on a normal kernel.
    expect(isLiveRuntime({ autopgPid: 999_999_999 })).toBe(false);
  });

  test('returns false for non-record / missing autopgPid', () => {
    expect(isLiveRuntime(null)).toBe(false);
    expect(isLiveRuntime({})).toBe(false);
    expect(isLiveRuntime({ autopgPid: 'string' })).toBe(false);
    expect(isLiveRuntime({ autopgPid: -1 })).toBe(false);
  });
});
