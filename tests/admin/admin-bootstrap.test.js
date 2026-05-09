/**
 * Tests for the per-consumer admin + manifest bootstrap (G3 D2).
 *
 * Uses a fresh tmp dir per test as the AUTOPG config root so we never
 * touch the real `~/.autopg/`. No postgres + no network here — the
 * end-to-end "create-app over psql" path lives in
 * tests/cli/create-app.test.js + tests/integration/verify-slug-rotation.test.sh.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PER_CONSUMER_ADMIN_FILE,
  PER_CONSUMER_MANIFEST_FILE,
  PER_CONSUMER_FILE_MODE,
  PER_CONSUMER_DIR_MODE,
  MANIFEST_SCHEMA_VERSION,
  getConsumerDir,
  getConsumerAdminPath,
  getConsumerManifestPath,
  buildConsumerRecords,
  bootstrapConsumerAdmin,
  readConsumerAdmin,
  readConsumerManifest,
} from '../../src/admin/admin-bootstrap.js';

const SAMPLE_LOCKED_ROOTS = Object.freeze([
  Object.freeze({
    id: 'automagik-genie-release',
    publisher: '@automagik/genie',
    issuer: 'https://token.actions.githubusercontent.com',
    identityRegexp: '^https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v.*$',
    description: 'genie release',
  }),
]);

const SAMPLE_CREATED_AT = '2026-05-09T18:00:00.000Z';
const SAMPLE_LAST_UPDATED = '2026-05-09T18:00:00.000Z';

let configDir;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-admin-test-'));
});

afterEach(() => {
  if (configDir && fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

describe('exports', () => {
  test('file/mode constants', () => {
    expect(PER_CONSUMER_ADMIN_FILE).toBe('admin.json');
    expect(PER_CONSUMER_MANIFEST_FILE).toBe('manifest.json');
    expect(PER_CONSUMER_FILE_MODE).toBe(0o600);
    expect(PER_CONSUMER_DIR_MODE).toBe(0o700);
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
  });
});

describe('getConsumerDir', () => {
  test('joins sanitized slug under configDir (flat — never nested)', () => {
    const result = getConsumerDir('demo', { configDir });
    expect(result.sanitized).toBe('demo');
    expect(result.consumerDir).toBe(path.join(configDir, 'demo'));
  });

  test('sanitizes scoped npm names like @demo/app to demo_app', () => {
    const result = getConsumerDir('@demo/app', { configDir });
    expect(result.sanitized).toBe('demo_app');
    expect(result.consumerDir).toBe(path.join(configDir, 'demo_app'));
  });

  test('throws on empty / whitespace slug', () => {
    expect(() => getConsumerDir('', { configDir })).toThrow(TypeError);
    expect(() => getConsumerDir('   ', { configDir })).toThrow(TypeError);
  });

  test('throws on slug that sanitizes to empty (all-symbols)', () => {
    expect(() => getConsumerDir('!!!', { configDir })).toThrow(/sanitizes to empty/);
  });

  test('throws on non-string slug', () => {
    expect(() => getConsumerDir(123, { configDir })).toThrow(TypeError);
    expect(() => getConsumerDir(null, { configDir })).toThrow(TypeError);
  });
});

describe('getConsumerAdminPath / getConsumerManifestPath', () => {
  test('admin path points at <slug>/admin.json', () => {
    const p = getConsumerAdminPath('demo', { configDir });
    expect(p).toBe(path.join(configDir, 'demo', 'admin.json'));
  });

  test('manifest path points at <slug>/manifest.json', () => {
    const p = getConsumerManifestPath('demo', { configDir });
    expect(p).toBe(path.join(configDir, 'demo', 'manifest.json'));
  });
});

describe('buildConsumerRecords (pure)', () => {
  test('produces admin + manifest records with shared slug + lockedRoots', () => {
    const result = buildConsumerRecords({
      slug: '@demo/app',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    });

    expect(result.sanitized).toBe('demo_app');
    expect(result.adminRecord.slug).toBe('demo_app');
    expect(result.manifestRecord.slug).toBe('demo_app');
    expect(result.adminRecord.lockedRoots).toEqual(result.manifestRecord.lockedRoots);
    expect(result.manifestRecord.schemaVersion).toBe(1);
  });

  test('deep-clones lockedRoots so frozen inputs become mutable outputs', () => {
    const result = buildConsumerRecords({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    });
    // The inputs are Object.frozen; clones must NOT be.
    expect(Object.isFrozen(result.adminRecord.lockedRoots)).toBe(false);
    expect(Object.isFrozen(result.adminRecord.lockedRoots[0])).toBe(false);
    // And mutating the clone must NOT affect the input.
    result.adminRecord.lockedRoots[0].id = 'mutated';
    expect(SAMPLE_LOCKED_ROOTS[0].id).toBe('automagik-genie-release');
  });

  test('throws when lockedRoots is not an array', () => {
    expect(() => buildConsumerRecords({
      slug: 'demo',
      lockedRoots: 'not-an-array',
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    })).toThrow(TypeError);
  });
});

describe('bootstrapConsumerAdmin (write path)', () => {
  function read(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  test('writes both files with mode 0600 + dir 0700', () => {
    const result = bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    });

    const dirStat = fs.statSync(result.consumerDir);
    const adminStat = fs.statSync(result.adminPath);
    const manifestStat = fs.statSync(result.manifestPath);

    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(adminStat.mode & 0o777).toBe(0o600);
    expect(manifestStat.mode & 0o777).toBe(0o600);

    const onDiskAdmin = read(result.adminPath);
    const onDiskManifest = read(result.manifestPath);

    expect(onDiskAdmin.slug).toBe('demo');
    expect(onDiskAdmin.lockedRoots).toEqual(JSON.parse(JSON.stringify(SAMPLE_LOCKED_ROOTS)));
    expect(onDiskAdmin.manifestPath).toBe(result.manifestPath);
    expect(onDiskManifest.schemaVersion).toBe(1);
    expect(onDiskManifest.slug).toBe('demo');
  });

  test('idempotent re-run overwrites lastUpdated but body stays parseable', () => {
    bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-01-01T00:00:00.000Z',
      configDir,
    });

    const result2 = bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUpdated: '2026-05-09T18:00:00.000Z',
      configDir,
    });

    const onDisk = read(result2.adminPath);
    expect(onDisk.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(onDisk.lastUpdated).toBe('2026-05-09T18:00:00.000Z');
  });

  test('rejects empty lastUpdated / createdAt', () => {
    expect(() => bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: '',
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    })).toThrow(/createdAt/);

    expect(() => bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: '',
      configDir,
    })).toThrow(/lastUpdated/);
  });

  test('per-consumer dir lives ONE level deep — never collides with host admin.json', () => {
    bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    });
    // No file directly at <configDir>/admin.json was written by us.
    expect(fs.existsSync(path.join(configDir, 'admin.json'))).toBe(false);
    // The per-consumer file IS at <configDir>/<slug>/admin.json.
    expect(fs.existsSync(path.join(configDir, 'demo', 'admin.json'))).toBe(true);
  });

  test('refuses to write through a symlink that escapes configDir (TOCTOU)', () => {
    const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-escape-target-'));
    try {
      // Create the consumer dir as a symlink pointing OUTSIDE the
      // canonical config root.
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(escapeTarget, path.join(configDir, 'demo'));

      let caught;
      try {
        bootstrapConsumerAdmin({
          slug: 'demo',
          lockedRoots: SAMPLE_LOCKED_ROOTS,
          createdAt: SAMPLE_CREATED_AT,
          lastUpdated: SAMPLE_LAST_UPDATED,
          configDir,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('EAUTOPGCONSUMERESCAPE');
    } finally {
      fs.rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

describe('readConsumerAdmin / readConsumerManifest', () => {
  test('returns null when file is absent', () => {
    expect(readConsumerAdmin('nonexistent', { configDir })).toBeNull();
    expect(readConsumerManifest('nonexistent', { configDir })).toBeNull();
  });

  test('returns null when file is corrupt JSON', () => {
    const dir = path.join(configDir, 'demo');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'admin.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json');
    expect(readConsumerAdmin('demo', { configDir })).toBeNull();
    expect(readConsumerManifest('demo', { configDir })).toBeNull();
  });

  test('round-trips a written record', () => {
    bootstrapConsumerAdmin({
      slug: 'demo',
      lockedRoots: SAMPLE_LOCKED_ROOTS,
      createdAt: SAMPLE_CREATED_AT,
      lastUpdated: SAMPLE_LAST_UPDATED,
      configDir,
    });
    const adminRead = readConsumerAdmin('demo', { configDir });
    const manifestRead = readConsumerManifest('demo', { configDir });
    expect(adminRead.slug).toBe('demo');
    expect(adminRead.createdAt).toBe(SAMPLE_CREATED_AT);
    expect(manifestRead.schemaVersion).toBe(1);
    expect(manifestRead.lockedRoots[0].id).toBe('automagik-genie-release');
  });
});
