/**
 * Tests for the `pgserve_meta` table bootstrap (singleton G3 foundation).
 *
 * These tests exercise the SQL string + the `bootstrapPgserveMeta()`
 * driver against a fake client. We intentionally do NOT spin up a real
 * postgres here — these are pure-shape tests. The end-to-end
 * "does the table actually get created" assertion lives in the
 * provision/gc integration tests once those verbs land.
 */

import { test, expect, describe } from 'bun:test';
import {
  PGSERVE_META_TABLE,
  PGSERVE_META_COLUMNS,
  getBootstrapStatements,
  getBootstrapSQL,
  bootstrapPgserveMeta,
  tableExistsFromRegclass,
} from '../../src/schema/pgserve-meta.js';

describe('exports', () => {
  test('PGSERVE_META_TABLE is the canonical table name', () => {
    expect(PGSERVE_META_TABLE).toBe('pgserve_meta');
  });

  test('PGSERVE_META_COLUMNS lists the owned columns and is frozen', () => {
    expect(Object.isFrozen(PGSERVE_META_COLUMNS)).toBe(true);
    expect(PGSERVE_META_COLUMNS).toContain('fingerprint');
    expect(PGSERVE_META_COLUMNS).toContain('database_name');
    expect(PGSERVE_META_COLUMNS).toContain('role_name');
    expect(PGSERVE_META_COLUMNS).toContain('last_used_at');
    // Cosign verify columns belong to src/cosign/schema.js, NOT here.
    expect(PGSERVE_META_COLUMNS).not.toContain('verified_at');
    expect(PGSERVE_META_COLUMNS).not.toContain('verified_identity');
    expect(PGSERVE_META_COLUMNS).not.toContain('verified_tier');
  });
});

describe('getBootstrapStatements', () => {
  test('returns an array of idempotent statements', () => {
    const statements = getBootstrapStatements();
    expect(Array.isArray(statements)).toBe(true);
    expect(statements.length).toBeGreaterThanOrEqual(3); // table + at least 2 indexes
    for (const sql of statements) {
      expect(typeof sql).toBe('string');
      expect(sql.length).toBeGreaterThan(0);
    }
  });

  test('first statement creates the table with IF NOT EXISTS', () => {
    const [createTable] = getBootstrapStatements();
    expect(createTable).toMatch(/CREATE TABLE IF NOT EXISTS public\.pgserve_meta/);
  });

  test('table + indexes are schema-qualified to public (matches cosign-meta-migration probe)', () => {
    const sql = getBootstrapStatements().join(';');
    // The upgrade pipeline probes to_regclass('public.pgserve_meta'),
    // so the bootstrap MUST land in public to stay discoverable.
    expect(sql).toContain('public.pgserve_meta');
    // Defensive: there is no unqualified mention of the bare name in
    // a CREATE / ON clause that would imply search_path resolution.
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS pgserve_meta(?!\w)/);
    expect(sql).not.toMatch(/ON pgserve_meta(?!\w)/);
  });

  test('table SQL declares the expected primary key + uniqueness', () => {
    const [createTable] = getBootstrapStatements();
    expect(createTable).toMatch(/fingerprint\s+TEXT\s+PRIMARY KEY/);
    expect(createTable).toMatch(/database_name\s+TEXT\s+NOT NULL UNIQUE/);
    expect(createTable).toMatch(/role_name\s+TEXT\s+NOT NULL/);
    expect(createTable).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
    expect(createTable).toMatch(/last_used_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
  });

  test('every index uses CREATE INDEX IF NOT EXISTS for idempotency', () => {
    const indexStatements = getBootstrapStatements().slice(1);
    expect(indexStatements.length).toBeGreaterThan(0);
    for (const sql of indexStatements) {
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    }
  });

  test('last_used_at index exists (gc uses it as staleness signal)', () => {
    const sql = getBootstrapStatements().join(';');
    expect(sql).toContain('pgserve_meta_last_used_at_idx');
    expect(sql).toContain('(last_used_at)');
  });

  test('publisher index exists (gc may filter by publisher)', () => {
    const sql = getBootstrapStatements().join(';');
    expect(sql).toContain('pgserve_meta_publisher_idx');
    expect(sql).toContain('(publisher)');
  });
});

describe('getBootstrapSQL', () => {
  test('joins statements with semicolons + newlines and ends with ";\\n"', () => {
    const sql = getBootstrapSQL();
    expect(sql.endsWith(';\n')).toBe(true);
    // statement separator
    expect(sql).toContain(';\n\n');
  });
});

describe('bootstrapPgserveMeta', () => {
  function fakeClient() {
    const calls = [];
    return {
      calls,
      query: async (sql) => {
        calls.push(sql);
        return { rows: [], rowCount: 0 };
      },
    };
  }

  test('runs every statement on the supplied client in order', async () => {
    const client = fakeClient();
    const ran = await bootstrapPgserveMeta(client);
    expect(ran).toEqual(getBootstrapStatements());
    expect(client.calls).toEqual(getBootstrapStatements());
  });

  test('rejects clients that do not expose an async query()', async () => {
    let caught;
    try {
      await bootstrapPgserveMeta(null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);

    let caught2;
    try {
      await bootstrapPgserveMeta({ query: 'not-a-function' });
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(TypeError);
  });

  test('propagates client.query errors (no swallowing)', async () => {
    const client = {
      query: async () => {
        throw new Error('boom');
      },
    };
    let caught;
    try {
      await bootstrapPgserveMeta(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toBe('boom');
  });
});

describe('tableExistsFromRegclass', () => {
  test('true only when the regclass query returned literal true', () => {
    expect(tableExistsFromRegclass(true)).toBe(true);
    expect(tableExistsFromRegclass(false)).toBe(false);
    expect(tableExistsFromRegclass(null)).toBe(false);
    expect(tableExistsFromRegclass(undefined)).toBe(false);
    expect(tableExistsFromRegclass('t')).toBe(false);
  });
});
