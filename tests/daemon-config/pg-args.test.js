/**
 * buildPostgresArgs coverage:
 *   - curated postgres.<key> entries land as `-c key=value`
 *   - postgres._extra entries land as `-c key=value`
 *   - curated keys win on conflict with _extra
 *   - invalid GUC names in _extra are dropped + warned (postgres still starts)
 *   - invalid value characters are dropped + warned
 *   - leading-`-` values are dropped + warned (CLI-flag spoofing)
 *   - booleans collapse to on/off
 *   - WAL replication GUCs are emitted from schema defaults
 */

import { test, expect, describe } from 'bun:test';

const { buildPostgresArgs } = require('../../src/settings-pg-args.cjs');
const { buildDefaults } = require('../../src/settings-schema.cjs');

function captureLogger() {
  const calls = [];
  return {
    calls,
    warn: (data, msg) => calls.push({ level: 'warn', data, msg }),
    info: (data, msg) => calls.push({ level: 'info', data, msg }),
    error: (data, msg) => calls.push({ level: 'error', data, msg }),
    debug: () => {},
  };
}

function pairsToObject(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    expect(args[i]).toBe('-c');
    const [k, ...rest] = args[i + 1].split('=');
    out[k] = rest.join('=');
  }
  return out;
}

describe('buildPostgresArgs', () => {
  test('emits -c flags for every curated postgres setting', () => {
    const defaults = buildDefaults().postgres;
    const { args } = buildPostgresArgs(defaults, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.max_connections).toBe('1000');
    expect(pairs.shared_buffers).toBe('128MB');
    expect(pairs.wal_level).toBe('logical');
    expect(pairs.max_replication_slots).toBe('10');
    expect(pairs.max_wal_senders).toBe('10');
    expect(pairs.wal_keep_size).toBe('512MB');
  });

  test('postgres._extra entries are emitted as -c flags', () => {
    const settings = {
      ...buildDefaults().postgres,
      _extra: { log_statement: 'all', log_connections: 'on' },
    };
    const { args } = buildPostgresArgs(settings, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    // Curated `log_statement` (default 'none') wins on conflict; non-curated
    // `log_connections` flows through.
    expect(pairs.log_statement).toBe('none');
    expect(pairs.log_connections).toBe('on');
  });

  test('curated keys win when also present in _extra', () => {
    const settings = {
      ...buildDefaults().postgres,
      shared_buffers: '256MB',
      _extra: { shared_buffers: '99TB' },
    };
    const { args, applied } = buildPostgresArgs(settings, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.shared_buffers).toBe('256MB');
    expect(applied.shared_buffers).toBe('256MB');
  });

  test('invalid GUC name in _extra is dropped + warned, postgres still gets valid args', () => {
    const logger = captureLogger();
    const settings = {
      ...buildDefaults().postgres,
      _extra: { 'FOO BAR': '1', shared_buffers: 'wonteverwin' },
    };
    const { args, applied } = buildPostgresArgs(settings, { logger });
    const pairs = pairsToObject(args);
    expect(pairs['FOO BAR']).toBeUndefined();
    expect(applied['FOO BAR']).toBeUndefined();
    // Curated still emitted
    expect(pairs.shared_buffers).toBe('128MB');
    const warn = logger.calls.find(
      (c) => c.level === 'warn' && c.data && c.data.guc === 'FOO BAR',
    );
    expect(warn).toBeDefined();
  });

  test('value with newline is dropped + warned', () => {
    const logger = captureLogger();
    const settings = {
      _extra: { log_destination: 'stderr\n--malicious' },
    };
    const { args } = buildPostgresArgs(settings, { logger });
    const pairs = pairsToObject(args);
    expect(pairs.log_destination).toBeUndefined();
    expect(
      logger.calls.find(
        (c) => c.level === 'warn' && c.msg && c.msg.includes('forbidden control'),
      ),
    ).toBeDefined();
  });

  test('value starting with "-" is dropped + warned (CLI flag spoofing)', () => {
    const logger = captureLogger();
    const settings = {
      _extra: { custom_param: '-rm-rf' },
    };
    const { args } = buildPostgresArgs(settings, { logger });
    const pairs = pairsToObject(args);
    expect(pairs.custom_param).toBeUndefined();
    expect(
      logger.calls.find(
        (c) => c.level === 'warn' && c.msg && c.msg.includes('"-"'),
      ),
    ).toBeDefined();
  });

  test('booleans collapse to on/off', () => {
    const settings = {
      ...buildDefaults().postgres,
      autovacuum: false,
      _extra: { ssl: true },
    };
    const { args } = buildPostgresArgs(settings, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.autovacuum).toBe('off');
    expect(pairs.ssl).toBe('on');
  });

  test('numeric values stringify cleanly', () => {
    const settings = {
      max_connections: 1000,
      log_min_duration_statement: -1,
      _extra: { tcp_keepalives_idle: 600 },
    };
    const { args } = buildPostgresArgs(settings, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.max_connections).toBe('1000');
    // -1 is the documented "off" sentinel, not a CLI flag, but our scalar
    // safety check rejects strings starting with `-`. Numbers pass through
    // straight to String(...) so this still lands.
    expect(pairs.log_min_duration_statement).toBe('-1');
    expect(pairs.tcp_keepalives_idle).toBe('600');
  });

  test('WAL replication block ships from schema defaults (no conditional path needed)', () => {
    // Sync mode used to add `-c wal_level=logical` etc. inline. Now those are
    // schema defaults, so they land regardless of sync.enabled. Verify all
    // four WAL GUCs are present in the default emit.
    const defaults = buildDefaults().postgres;
    const { args } = buildPostgresArgs(defaults, { logger: captureLogger() });
    const pairs = pairsToObject(args);
    expect(pairs.wal_level).toBe('logical');
    expect(pairs.max_replication_slots).toBe('10');
    expect(pairs.max_wal_senders).toBe('10');
    expect(pairs.wal_keep_size).toBe('512MB');
  });

  test('returns empty when postgres section is missing', () => {
    const { args, applied } = buildPostgresArgs(undefined, { logger: captureLogger() });
    expect(args).toEqual([]);
    expect(applied).toEqual({});
  });
});
