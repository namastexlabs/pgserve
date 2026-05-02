/**
 * Writer coverage:
 *   - atomic write produces mode 0600
 *   - validation errors propagate (don't write a partial file)
 *   - etag mismatch throws EtagMismatchError, file untouched
 *   - setLeaf round-trips through loader
 *   - postgres._extra entries persist
 *   - initSettings refuses to clobber without force
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  writeSettings,
  setLeaf,
  removeExtra,
  initSettings,
  serializeSettings,
} = require('../../src/settings-writer.cjs');

const {
  loadEffectiveConfig,
  computeEtag,
} = require('../../src/settings-loader.cjs');

const {
  ValidationError,
  EtagMismatchError,
  ERROR_CODES,
} = require('../../src/settings-validator.cjs');

const { buildDefaults } = require('../../src/settings-schema.cjs');

let tmpDir;
let settingsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-writer-'));
  settingsPath = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function statMode(p) {
  // POSIX: bottom 9 bits are the perm mask. On Windows we just assert
  // the file exists and skip the mode check.
  return fs.statSync(p).mode & 0o777;
}

describe('writeSettings', () => {
  test('writes file at mode 0600 (POSIX)', () => {
    writeSettings(buildDefaults(), { settingsPath });
    expect(fs.existsSync(settingsPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statMode(settingsPath)).toBe(0o600);
    }
  });

  test('atomic swap: a tmp sibling exists only briefly', () => {
    writeSettings(buildDefaults(), { settingsPath });
    const dir = path.dirname(settingsPath);
    const leftover = fs.readdirSync(dir).filter((n) => n.includes('.tmp.'));
    expect(leftover).toEqual([]);
  });

  test('returns an etag matching what the loader computes', () => {
    const { etag: writeEtag } = writeSettings(buildDefaults(), { settingsPath });
    const { etag: loadEtag } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(writeEtag).toBe(loadEtag);
  });

  test('validation error does not produce a file', () => {
    expect.assertions(2);
    try {
      writeSettings(
        { server: { port: 99999 } }, // out of range
        { settingsPath },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(fs.existsSync(settingsPath)).toBe(false);
    }
  });

  test('ifMatch=correct etag: write succeeds', () => {
    const { etag: e0 } = writeSettings(buildDefaults(), { settingsPath });
    const tree = buildDefaults();
    tree.server.port = 9001;
    const { etag: e1 } = writeSettings(tree, { ifMatch: e0, settingsPath });
    expect(e1).not.toBe(e0);
  });

  test('ifMatch=stale etag: throws EtagMismatchError, file untouched', () => {
    const { etag: e0 } = writeSettings(buildDefaults(), { settingsPath });
    // External writer mutates the file between the read and the would-be write.
    const tree = buildDefaults();
    tree.server.port = 9100;
    writeSettings(tree, { settingsPath });

    const tree2 = buildDefaults();
    tree2.server.port = 9200;
    expect.assertions(3);
    try {
      writeSettings(tree2, { ifMatch: e0, settingsPath });
    } catch (err) {
      expect(err).toBeInstanceOf(EtagMismatchError);
      expect(err.code).toBe(ERROR_CODES.ETAG_MISMATCH);
      // File still has the second write's content (not the third).
      const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(onDisk.server.port).toBe(9100);
    }
  });
});

describe('setLeaf', () => {
  test('round-trips through loader', () => {
    setLeaf('postgres.shared_buffers', '256MB', { settingsPath });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.postgres.shared_buffers).toBe('256MB');
  });

  test('coerces string values to declared type', () => {
    setLeaf('server.port', '9000', { settingsPath });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.server.port).toBe(9000);
  });

  test('writes new postgres._extra entry', () => {
    setLeaf('postgres._extra.log_statement', 'all', { settingsPath });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.postgres._extra).toEqual({ log_statement: 'all' });
  });

  test('rejects an INVALID_GUC_NAME without writing the file', () => {
    expect.assertions(2);
    try {
      setLeaf('postgres._extra.shared buffers', '128MB', { settingsPath });
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_NAME);
      expect(fs.existsSync(settingsPath)).toBe(false);
    }
  });

  test('preserves existing extras when adding a new one', () => {
    setLeaf('postgres._extra.log_statement', 'all', { settingsPath });
    setLeaf('postgres._extra.statement_timeout', '5000', { settingsPath });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.postgres._extra.log_statement).toBe('all');
    // statement_timeout is in the extras map, not coerced (since this is a free-form value).
    expect(settings.postgres._extra.statement_timeout).toBe('5000');
  });
});

describe('removeExtra', () => {
  test('removes a single extra; other extras survive', () => {
    setLeaf('postgres._extra.log_statement', 'all', { settingsPath });
    setLeaf('postgres._extra.client_min_messages', 'warning', { settingsPath });
    removeExtra('log_statement', { settingsPath });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.postgres._extra).toEqual({ client_min_messages: 'warning' });
  });

  test('no-op when the key is absent', () => {
    initSettings({ settingsPath });
    const before = fs.readFileSync(settingsPath);
    removeExtra('nonexistent', { settingsPath });
    const after = fs.readFileSync(settingsPath);
    expect(after.toString()).toBe(before.toString());
  });
});

describe('initSettings', () => {
  test('writes defaults on a fresh path', () => {
    initSettings({ settingsPath });
    expect(fs.existsSync(settingsPath)).toBe(true);
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.server.port).toBe(8432);
  });

  test('refuses to clobber without force', () => {
    initSettings({ settingsPath });
    expect.assertions(1);
    try {
      initSettings({ settingsPath });
    } catch (err) {
      expect(err.code).toBe('EEXIST');
    }
  });

  test('force overwrites', () => {
    setLeaf('server.port', '9000', { settingsPath });
    initSettings({ settingsPath, force: true });
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.server.port).toBe(8432);
  });
});

describe('serializeSettings determinism', () => {
  test('two calls with the same input yield byte-equal JSON', () => {
    const tree = buildDefaults();
    const a = serializeSettings(tree);
    const b = serializeSettings(tree);
    expect(a).toBe(b);
    expect(computeEtag(Buffer.from(a, 'utf8'))).toBe(
      computeEtag(Buffer.from(b, 'utf8')),
    );
  });
});
