/**
 * Migration coverage:
 *   - first run on a system with `~/.pgserve/config.json` migrates to
 *     `~/.autopg/settings.json`
 *   - second run is a no-op (marker file present)
 *   - skipped entirely when AUTOPG_CONFIG_DIR or PGSERVE_CONFIG_DIR is set
 *   - missing legacy dir → no-op
 *   - both dirs exist (no marker) → marker dropped, no copy
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  migrateIfNeeded,
  resolveDirs,
  buildSettingsFromLegacyConfig,
  MARKER_FILENAME,
} = require('../../src/settings-migrate.cjs');

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-migrate-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function legacyDir() {
  return path.join(tmpHome, '.pgserve');
}
function freshDir() {
  return path.join(tmpHome, '.autopg');
}
function seedLegacy({ port = 8432, dataDir } = {}) {
  fs.mkdirSync(legacyDir(), { recursive: true, mode: 0o755 });
  const config = { port, dataDir: dataDir ?? path.join(legacyDir(), 'data'), registeredAt: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(path.join(legacyDir(), 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(legacyDir(), 'data'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir(), 'data', 'README.md'), '# data');
}

describe('migrateIfNeeded', () => {
  test('first run: copies legacy dir, builds settings.json, drops marker', () => {
    seedLegacy({ port: 8500 });
    const result = migrateIfNeeded({ home: tmpHome, env: {} });
    expect(result.migrated).toBe(true);
    expect(result.reason).toBe('copied');

    expect(fs.existsSync(path.join(legacyDir(), MARKER_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(freshDir(), 'data', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir(), 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir(), 'settings.json'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(freshDir(), 'settings.json'), 'utf8'));
    expect(settings.server.port).toBe(8500);
  });

  test('second run is idempotent (marker present)', () => {
    seedLegacy();
    const first = migrateIfNeeded({ home: tmpHome, env: {} });
    expect(first.migrated).toBe(true);

    const second = migrateIfNeeded({ home: tmpHome, env: {} });
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe('already-migrated');
  });

  test('skipped when AUTOPG_CONFIG_DIR is set', () => {
    seedLegacy();
    const result = migrateIfNeeded({
      home: tmpHome,
      env: { AUTOPG_CONFIG_DIR: '/tmp/somewhere' },
    });
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('env-override-set');
    expect(fs.existsSync(freshDir())).toBe(false);
  });

  test('skipped when PGSERVE_CONFIG_DIR is set', () => {
    seedLegacy();
    const result = migrateIfNeeded({
      home: tmpHome,
      env: { PGSERVE_CONFIG_DIR: '/tmp/legacy-custom' },
    });
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('env-override-set');
  });

  test('no legacy dir → no-op', () => {
    const result = migrateIfNeeded({ home: tmpHome, env: {} });
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('no-legacy-dir');
  });

  test('both dirs exist with no marker → marker dropped, no copy', () => {
    seedLegacy();
    fs.mkdirSync(freshDir(), { recursive: true });
    fs.writeFileSync(path.join(freshDir(), 'sentinel.txt'), "don't touch me");

    const result = migrateIfNeeded({ home: tmpHome, env: {} });
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('both-exist-marker-set');
    expect(fs.existsSync(path.join(legacyDir(), MARKER_FILENAME))).toBe(true);
    // The pre-existing fresh dir is untouched
    expect(fs.readFileSync(path.join(freshDir(), 'sentinel.txt'), 'utf8')).toBe(
      "don't touch me",
    );
  });

  test('preserves mtimes on copied files', () => {
    seedLegacy();
    const dataPath = path.join(legacyDir(), 'data', 'README.md');
    const past = new Date('2024-06-15T12:00:00Z');
    fs.utimesSync(dataPath, past, past);
    migrateIfNeeded({ home: tmpHome, env: {} });
    const newStat = fs.statSync(path.join(freshDir(), 'data', 'README.md'));
    expect(Math.floor(newStat.mtimeMs / 1000)).toBe(Math.floor(past.getTime() / 1000));
  });

  test('settings.json is mode 0600 after migration (POSIX)', () => {
    if (process.platform === 'win32') return;
    seedLegacy();
    migrateIfNeeded({ home: tmpHome, env: {} });
    const mode = fs.statSync(path.join(freshDir(), 'settings.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('resolveDirs', () => {
  test('default home → legacy=~/.pgserve, fresh=~/.autopg', () => {
    const dirs = resolveDirs({ home: '/home/u', env: {} });
    expect(dirs.legacy).toBe('/home/u/.pgserve');
    expect(dirs.fresh).toBe('/home/u/.autopg');
  });

  test('with override env, returns skipped:true and null dirs', () => {
    const dirs = resolveDirs({ home: '/home/u', env: { PGSERVE_CONFIG_DIR: '/x' } });
    expect(dirs.skipped).toBe(true);
    expect(dirs.legacy).toBe(null);
  });
});

describe('buildSettingsFromLegacyConfig', () => {
  test('translates port + dataDir into the new schema', () => {
    const json = buildSettingsFromLegacyConfig({ port: 8888, dataDir: '/var/lib/pgserve' });
    const tree = JSON.parse(json);
    expect(tree.server.port).toBe(8888);
    expect(tree.runtime.dataDir).toBe('/var/lib/pgserve');
    expect(tree._migratedFrom).toBe('~/.pgserve');
  });

  test('uses defaults when legacy config is null/garbage', () => {
    const json = buildSettingsFromLegacyConfig(null);
    const tree = JSON.parse(json);
    expect(tree.server.port).toBe(8432);
  });
});
