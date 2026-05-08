/**
 * Tests for the user-extensible cosign trust store (singleton G3 — `trust` verb).
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readTrustStore,
  writeTrustStore,
  addUserTrust,
  removeUserTrust,
  listAllTrust,
  validateEntry,
  getTrustFilePath,
  __testInternals,
} from '../../src/cosign/trust-store.js';

let homeDir;
beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-trust-test-'));
});
afterEach(() => {
  if (homeDir && fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('readTrustStore', () => {
  test('returns empty store when file is missing', () => {
    const store = readTrustStore({ homeDir });
    expect(store.schemaVersion).toBe(__testInternals.SCHEMA_VERSION);
    expect(store.entries).toEqual([]);
  });

  test('throws ETRUSTSTORE on invalid JSON', () => {
    fs.mkdirSync(path.join(homeDir, '.pgserve', 'trust'), { recursive: true });
    fs.writeFileSync(getTrustFilePath(homeDir), '{not-json');
    expect(() => readTrustStore({ homeDir })).toThrow(/not valid JSON/);
  });

  test('throws ETRUSTSTORE on missing entries array', () => {
    fs.mkdirSync(path.join(homeDir, '.pgserve', 'trust'), { recursive: true });
    fs.writeFileSync(getTrustFilePath(homeDir), JSON.stringify({ schemaVersion: 1 }));
    expect(() => readTrustStore({ homeDir })).toThrow(/missing the entries array/);
  });

  test('throws on unsupported schemaVersion', () => {
    fs.mkdirSync(path.join(homeDir, '.pgserve', 'trust'), { recursive: true });
    fs.writeFileSync(
      getTrustFilePath(homeDir),
      JSON.stringify({ schemaVersion: 99, entries: [] }),
    );
    expect(() => readTrustStore({ homeDir })).toThrow(/schemaVersion 99 unsupported/);
  });
});

describe('writeTrustStore', () => {
  test('creates the trust dir with mode 0700 and the file with 0600', () => {
    writeTrustStore({ schemaVersion: 1, entries: [] }, { homeDir });
    const file = getTrustFilePath(homeDir);
    expect(fs.existsSync(file)).toBe(true);
    const dirStat = fs.statSync(path.dirname(file));
    const fileStat = fs.statSync(file);
    expect((dirStat.mode & 0o777)).toBe(__testInternals.DIR_MODE);
    expect((fileStat.mode & 0o777)).toBe(__testInternals.FILE_MODE);
  });

  test('writes valid JSON readable round-trip', () => {
    const original = {
      schemaVersion: 1,
      entries: [
        {
          id: 'fork-build',
          publisher: 'acme/fork',
          issuer: 'https://token.actions.githubusercontent.com',
          identityRegexp: '^https://github.com/acme/.*$',
          description: 'fork build',
          addedAt: '2026-05-08T12:00:00.000Z',
        },
      ],
    };
    writeTrustStore(original, { homeDir });
    const round = readTrustStore({ homeDir });
    expect(round.schemaVersion).toBe(1);
    expect(round.entries).toEqual(original.entries);
  });

  test('rejects malformed input', () => {
    expect(() => writeTrustStore({}, { homeDir })).toThrow(/store must be/);
    expect(() => writeTrustStore({ entries: 'not-an-array' }, { homeDir })).toThrow();
  });
});

describe('validateEntry', () => {
  test('accepts a minimal valid entry', () => {
    const e = validateEntry({
      id: 'ok',
      issuer: 'https://example.test/oidc',
      identityRegexp: '^https://example/.+$',
    });
    expect(e.id).toBe('ok');
    expect(e.publisher).toBe('');
    expect(e.description).toBe('');
    expect(typeof e.addedAt).toBe('string');
  });

  test('rejects empty id / issuer / identityRegexp', () => {
    expect(() => validateEntry({ id: '', issuer: 'x', identityRegexp: 'x' })).toThrow();
    expect(() => validateEntry({ id: 'x', issuer: '', identityRegexp: 'x' })).toThrow();
    expect(() => validateEntry({ id: 'x', issuer: 'x', identityRegexp: '' })).toThrow();
  });

  test('rejects an id with disallowed chars', () => {
    expect(() => validateEntry({ id: 'has space', issuer: 'x', identityRegexp: '.+' })).toThrow(/must match/);
    expect(() => validateEntry({ id: '/leading-slash', issuer: 'x', identityRegexp: '.+' })).toThrow();
  });

  test('rejects an invalid regex', () => {
    expect(() => validateEntry({ id: 'x', issuer: 'x', identityRegexp: '(' })).toThrow(/not a valid regex/);
  });
});

describe('addUserTrust', () => {
  test('adds a new entry and is idempotent on the same id (replace semantics)', () => {
    const a = addUserTrust(
      { id: 'fork', issuer: 'https://i', identityRegexp: '^https://github.com/acme/.*$' },
      { homeDir },
    );
    expect(a.id).toBe('fork');
    addUserTrust(
      {
        id: 'fork',
        issuer: 'https://i2',
        identityRegexp: '^https://github.com/acme/.*$',
        description: 'updated',
      },
      { homeDir },
    );
    const store = readTrustStore({ homeDir });
    expect(store.entries.length).toBe(1);
    expect(store.entries[0].issuer).toBe('https://i2');
    expect(store.entries[0].description).toBe('updated');
  });

  test('refuses to shadow a hardcoded id', () => {
    let caught;
    try {
      addUserTrust(
        {
          id: 'automagik-genie-release',
          issuer: 'https://i',
          identityRegexp: '.+',
        },
        { homeDir },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETRUSTSHADOW');
  });
});

describe('removeUserTrust', () => {
  test('returns false when the id is unknown', () => {
    expect(removeUserTrust('does-not-exist', { homeDir })).toBe(false);
  });

  test('removes a previously-added user entry', () => {
    addUserTrust(
      { id: 'fork', issuer: 'https://i', identityRegexp: '^https://github.com/acme/.*$' },
      { homeDir },
    );
    expect(removeUserTrust('fork', { homeDir })).toBe(true);
    const store = readTrustStore({ homeDir });
    expect(store.entries.length).toBe(0);
  });

  test('refuses to remove a hardcoded id', () => {
    let caught;
    try {
      removeUserTrust('automagik-genie-release', { homeDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETRUSTHARDCODED');
  });
});

describe('listAllTrust', () => {
  test('hardcoded entries appear first, all marked source/removable', () => {
    const list = listAllTrust({ homeDir });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((e) => e.source === 'hardcoded' || e.source === 'user')).toBe(true);
    expect(list.every((e) => typeof e.removable === 'boolean')).toBe(true);
    // Hardcoded come first.
    const firstUserIdx = list.findIndex((e) => e.source === 'user');
    if (firstUserIdx >= 0) {
      const lastHardIdx = list.map((e) => e.source).lastIndexOf('hardcoded');
      expect(firstUserIdx).toBeGreaterThan(lastHardIdx);
    }
  });

  test('reflects user additions', () => {
    const before = listAllTrust({ homeDir });
    addUserTrust(
      { id: 'fork', issuer: 'https://i', identityRegexp: '^https://github.com/acme/.*$' },
      { homeDir },
    );
    const after = listAllTrust({ homeDir });
    expect(after.length).toBe(before.length + 1);
    expect(after.find((e) => e.id === 'fork' && e.source === 'user' && e.removable)).toBeDefined();
  });
});
