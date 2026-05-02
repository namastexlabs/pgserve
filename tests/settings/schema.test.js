/**
 * Schema sanity checks: every section/leaf has a known type, defaults
 * round-trip, and the WAL-replication block + max_connections are
 * promoted into the postgres section (the values that used to be
 * hardcoded in postgres.js).
 */

import { test, expect, describe } from 'bun:test';

const {
  SCHEMA,
  SCHEMA_VERSION,
  flattenSchema,
  buildDefaults,
  GUC_NAME_REGEX,
} = require('../../src/settings-schema.cjs');

describe('settings-schema', () => {
  test('top-level sections are exactly server / runtime / sync / supervision / security / audit / postgres / ui', () => {
    expect(Object.keys(SCHEMA).sort()).toEqual(
      ['audit', 'postgres', 'runtime', 'security', 'server', 'supervision', 'sync', 'ui'].sort(),
    );
  });

  test('schema version is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('every leaf descriptor has a known type', () => {
    const knownTypes = new Set(['int', 'bool', 'string', 'enum', 'guc_map']);
    for (const [section, fields] of Object.entries(SCHEMA)) {
      for (const [field, descriptor] of Object.entries(fields)) {
        expect(knownTypes.has(descriptor.type)).toBe(true);
        expect(descriptor).toHaveProperty('default');
        if (descriptor.type === 'enum') {
          expect(Array.isArray(descriptor.enum)).toBe(true);
          expect(descriptor.enum).toContain(descriptor.default);
        }
        if (descriptor.range) {
          const [min, max] = descriptor.range;
          expect(typeof min).toBe('number');
          expect(typeof max).toBe('number');
          expect(min).toBeLessThanOrEqual(max);
        }
        // Guard typo: section.field path is well-formed
        expect(`${section}.${field}`).toMatch(/^[a-z]+\.[A-Za-z_][A-Za-z0-9_]*$/);
      }
    }
  });

  test('postgres.max_connections default is 1000 (promoted from postgres.js)', () => {
    expect(SCHEMA.postgres.max_connections.default).toBe(1000);
  });

  test('WAL replication GUCs are promoted into the postgres section', () => {
    expect(SCHEMA.postgres.wal_level.default).toBe('logical');
    expect(SCHEMA.postgres.max_replication_slots.default).toBe(10);
    expect(SCHEMA.postgres.max_wal_senders.default).toBe(10);
    expect(SCHEMA.postgres.wal_keep_size.default).toBe('512MB');
  });

  test('postgres._extra is the free-form GUC passthrough map', () => {
    expect(SCHEMA.postgres._extra.type).toBe('guc_map');
    expect(SCHEMA.postgres._extra.default).toEqual({});
  });

  test('GUC_NAME_REGEX accepts canonical names and rejects spaces/uppercase/leading digits', () => {
    expect(GUC_NAME_REGEX.test('shared_buffers')).toBe(true);
    expect(GUC_NAME_REGEX.test('log_statement')).toBe(true);
    expect(GUC_NAME_REGEX.test('a1b2_c3')).toBe(true);
    expect(GUC_NAME_REGEX.test('Shared_Buffers')).toBe(false);
    expect(GUC_NAME_REGEX.test('shared buffers')).toBe(false);
    expect(GUC_NAME_REGEX.test('1shared')).toBe(false);
    expect(GUC_NAME_REGEX.test('')).toBe(false);
    expect(GUC_NAME_REGEX.test('-shared')).toBe(false);
  });

  test('flattenSchema returns dotted keys for every leaf', () => {
    const flat = flattenSchema();
    expect(flat['server.port']).toBeDefined();
    expect(flat['postgres.shared_buffers']).toBeDefined();
    expect(flat['postgres._extra']).toBeDefined();
    expect(flat['ui.theme']).toBeDefined();
  });

  test('buildDefaults clones nested values so callers cannot mutate the schema', () => {
    const a = buildDefaults();
    a.postgres._extra.injected = 'oops';
    const b = buildDefaults();
    expect(b.postgres._extra).toEqual({});
  });
});
