/**
 * Loader coverage:
 *   - defaults < file < env precedence
 *   - source attribution per leaf
 *   - etag is deterministic for unchanged files
 *   - empty-file etag sentinel
 *   - AUTOPG_<X> beats PGSERVE_<X> on conflict
 *   - PGSERVE_<X>-only path emits a one-time deprecation log
 *   - missing-file path returns defaults + empty etag
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  loadEffectiveConfig,
  computeEtag,
  EMPTY_FILE_ETAG,
  _internals,
} = require('../../src/settings-loader.cjs');

let tmpDir;
let settingsPath;

function captureLogger() {
  const calls = [];
  return {
    calls,
    warn: (data, msg) => calls.push({ level: 'warn', data, msg }),
    info: () => {},
    error: () => {},
    debug: () => {},
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-loader-'));
  settingsPath = path.join(tmpDir, 'settings.json');
  _internals.resetLegacyEnvWarning();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadEffectiveConfig', () => {
  test('returns schema defaults when no file exists', () => {
    const { settings, sources, etag } = loadEffectiveConfig({
      env: {},
      settingsPath,
    });
    expect(settings.server.port).toBe(8432);
    expect(sources['server.port']).toBe('default');
    expect(etag).toBe(EMPTY_FILE_ETAG);
  });

  test('file value beats default and source is "file"', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ server: { port: 9000 }, postgres: { shared_buffers: '256MB' } }),
    );
    const { settings, sources } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.server.port).toBe(9000);
    expect(sources['server.port']).toBe('file');
    expect(settings.postgres.shared_buffers).toBe('256MB');
    expect(sources['postgres.shared_buffers']).toBe('file');
  });

  test('env beats both file and default; AUTOPG_PORT wins over PGSERVE_PORT', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ server: { port: 9000 } }));
    const { settings, sources } = loadEffectiveConfig({
      env: { AUTOPG_PORT: '8500', PGSERVE_PORT: '8501' },
      settingsPath,
    });
    expect(settings.server.port).toBe(8500);
    expect(sources['server.port']).toBe('env:AUTOPG_PORT');
  });

  test('PGSERVE_PORT-only path takes effect and emits one deprecation log', () => {
    const logger = captureLogger();
    const { settings, sources } = loadEffectiveConfig({
      env: { PGSERVE_PORT: '9100' },
      settingsPath,
      logger,
    });
    expect(settings.server.port).toBe(9100);
    expect(sources['server.port']).toBe('env:PGSERVE_PORT');
    const dep = logger.calls.find((c) => c.msg && c.msg.includes('PGSERVE_PORT'));
    expect(dep).toBeDefined();
  });

  test('deprecation log is emitted at most once per process', () => {
    const logger = captureLogger();
    loadEffectiveConfig({ env: { PGSERVE_PORT: '9100' }, settingsPath, logger });
    loadEffectiveConfig({ env: { PGSERVE_HOST: '1.2.3.4' }, settingsPath, logger });
    const warns = logger.calls.filter((c) => c.level === 'warn');
    expect(warns.length).toBe(1);
  });

  test('etag is deterministic for unchanged files', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ server: { port: 9000 } }),
    );
    const a = loadEffectiveConfig({ env: {}, settingsPath });
    const b = loadEffectiveConfig({ env: {}, settingsPath });
    expect(a.etag).toBe(b.etag);
    expect(a.etag).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('etag changes after a file mutation', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ server: { port: 9000 } }));
    const before = loadEffectiveConfig({ env: {}, settingsPath }).etag;
    fs.writeFileSync(settingsPath, JSON.stringify({ server: { port: 9100 } }));
    const after = loadEffectiveConfig({ env: {}, settingsPath }).etag;
    expect(before).not.toBe(after);
  });

  test('throws SyntaxError with helpful path on malformed JSON', () => {
    fs.writeFileSync(settingsPath, '{not json');
    expect.assertions(2);
    try {
      loadEffectiveConfig({ env: {}, settingsPath });
    } catch (err) {
      expect(err).toBeInstanceOf(SyntaxError);
      expect(err.message).toContain(settingsPath);
    }
  });

  test('booleans coerce from env strings "true"/"false"/"1"/"0"', () => {
    expect(
      loadEffectiveConfig({ env: { AUTOPG_AUTO_PROVISION: 'true' }, settingsPath })
        .settings.runtime.autoProvision,
    ).toBe(true);
    expect(
      loadEffectiveConfig({ env: { AUTOPG_AUTO_PROVISION: '0' }, settingsPath })
        .settings.runtime.autoProvision,
    ).toBe(false);
  });

  test('postgres curated leafs default to schema values', () => {
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    expect(settings.postgres.max_connections).toBe(1000);
    expect(settings.postgres.wal_level).toBe('logical');
    expect(settings.postgres._extra).toEqual({});
  });
});

describe('computeEtag', () => {
  test('empty file returns sentinel', () => {
    expect(computeEtag(null)).toBe(EMPTY_FILE_ETAG);
    expect(computeEtag(Buffer.from(''))).toBe(EMPTY_FILE_ETAG);
  });

  test('two equal byte sequences hash to the same etag', () => {
    const a = computeEtag(Buffer.from('{"server":{"port":9000}}'));
    const b = computeEtag(Buffer.from('{"server":{"port":9000}}'));
    expect(a).toBe(b);
  });
});
