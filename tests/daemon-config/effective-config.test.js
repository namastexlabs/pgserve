/**
 * Effective-config + pg-args integration:
 *   - settings.json values land in `-c` flags
 *   - env override beats file (and source attribution flips to env:NAME)
 *   - PGSERVE_<X>-only path emits a deprecation log and still wins
 *   - sync.enabled does not duplicate WAL GUCs (schema defaults already cover them)
 *
 * These tests do NOT spawn postgres — they drive the same code path
 * `_startPostgres()` uses for arg construction, which is the contract
 * Group 3 needs to honor.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadEffectiveConfig, _internals } = require('../../src/settings-loader.cjs');
const { buildPostgresArgs } = require('../../src/settings-pg-args.cjs');

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

function pairsToObject(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const [k, ...rest] = args[i + 1].split('=');
    out[k] = rest.join('=');
  }
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-daemon-cfg-'));
  settingsPath = path.join(tmpDir, 'settings.json');
  _internals.resetLegacyEnvWarning();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadEffectiveConfig → buildPostgresArgs', () => {
  test('file value lands as -c flag', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ postgres: { shared_buffers: '256MB' } }),
    );
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    const { args } = buildPostgresArgs(settings.postgres, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.shared_buffers).toBe('256MB');
  });

  test('postgres._extra flows through into -c flags', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        postgres: {
          _extra: { log_statement: 'all', tcp_keepalives_idle: 600 },
        },
      }),
    );
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    const { args } = buildPostgresArgs(settings.postgres, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    // `log_statement` is curated with default `none`, so curated wins —
    // `_extra.log_statement` is overwritten. `tcp_keepalives_idle` is non-
    // curated, so it lands.
    expect(pairs.log_statement).toBe('none');
    expect(pairs.tcp_keepalives_idle).toBe('600');
  });

  test('env override beats file for server.port (loader contract for cluster.js)', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ server: { port: 8432 } }),
    );
    const { settings, sources } = loadEffectiveConfig({
      env: { PGSERVE_PORT: '9000' },
      settingsPath,
      logger: captureLogger(),
    });
    expect(settings.server.port).toBe(9000);
    expect(sources['server.port']).toBe('env:PGSERVE_PORT');
  });

  test('PGSERVE_PORT-only triggers one deprecation log and still wins', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ server: { port: 8432 } }),
    );
    const logger = captureLogger();
    const { settings } = loadEffectiveConfig({
      env: { PGSERVE_PORT: '9000' },
      settingsPath,
      logger,
    });
    expect(settings.server.port).toBe(9000);
    const dep = logger.calls.find(
      (c) => c.level === 'warn' && c.msg && c.msg.includes('PGSERVE_PORT'),
    );
    expect(dep).toBeDefined();
  });

  test('AUTOPG_PORT wins over PGSERVE_PORT on conflict', () => {
    const { settings, sources } = loadEffectiveConfig({
      env: { AUTOPG_PORT: '8500', PGSERVE_PORT: '8501' },
      settingsPath,
      logger: captureLogger(),
    });
    expect(settings.server.port).toBe(8500);
    expect(sources['server.port']).toBe('env:AUTOPG_PORT');
  });

  test('sync.enabled=true does not double-emit WAL GUCs (schema covers them)', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ sync: { enabled: true } }),
    );
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    const { args } = buildPostgresArgs(settings.postgres, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    // Each WAL GUC appears exactly once in the args list.
    expect(pairs.wal_level).toBe('logical');
    expect(pairs.max_replication_slots).toBe('10');
    expect(pairs.max_wal_senders).toBe('10');
    expect(pairs.wal_keep_size).toBe('512MB');
    // Verify single occurrences by re-counting `-c key=` prefixes.
    const occurrences = (key) =>
      args.filter((a, idx) => idx % 2 === 1 && a.startsWith(`${key}=`)).length;
    expect(occurrences('wal_level')).toBe(1);
    expect(occurrences('max_replication_slots')).toBe(1);
    expect(occurrences('max_wal_senders')).toBe(1);
    expect(occurrences('wal_keep_size')).toBe(1);
  });

  test('user can override WAL defaults via file', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ postgres: { wal_keep_size: '1GB', max_replication_slots: 20 } }),
    );
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    const { args } = buildPostgresArgs(settings.postgres, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.wal_keep_size).toBe('1GB');
    expect(pairs.max_replication_slots).toBe('20');
  });

  test('invalid _extra GUC name is dropped at boot, postgres still gets valid args', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        postgres: {
          _extra: { 'FOO BAR': '1', timezone: 'UTC' },
        },
      }),
    );
    const logger = captureLogger();
    const { settings } = loadEffectiveConfig({ env: {}, settingsPath });
    const { args, applied } = buildPostgresArgs(settings.postgres, { logger });
    const pairs = pairsToObject(args);
    expect(pairs['FOO BAR']).toBeUndefined();
    expect(applied['FOO BAR']).toBeUndefined();
    expect(pairs.timezone).toBe('UTC');
    const dropWarn = logger.calls.find(
      (c) =>
        c.level === 'warn' &&
        c.data &&
        c.data.source === '_extra' &&
        c.data.guc === 'FOO BAR',
    );
    expect(dropWarn).toBeDefined();
  });
});
