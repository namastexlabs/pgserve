/**
 * Tests for the `autopg_meta` table bootstrap (G3 of
 * `autopg-distribution-cutover-finalize`).
 *
 * Pure-shape tests against a fake client. The end-to-end "does the
 * table actually get created" assertion lives in the create-app
 * integration test alongside the verb itself.
 */

import { test, expect, describe } from 'bun:test';
import {
  AUTOPG_META_TABLE,
  AUTOPG_META_COLUMNS,
  getBootstrapStatements,
  getBootstrapSQL,
  bootstrapAutopgMeta,
  tableExistsFromRegclass,
} from '../../src/schema/autopg-meta.js';

describe('exports', () => {
  test('AUTOPG_META_TABLE is the canonical table name', () => {
    expect(AUTOPG_META_TABLE).toBe('autopg_meta');
  });

  test('AUTOPG_META_COLUMNS lists the owned columns and is frozen', () => {
    expect(Object.isFrozen(AUTOPG_META_COLUMNS)).toBe(true);
    expect(AUTOPG_META_COLUMNS).toContain('slug');
    expect(AUTOPG_META_COLUMNS).toContain('manifest_path');
    expect(AUTOPG_META_COLUMNS).toContain('locked_roots');
    expect(AUTOPG_META_COLUMNS).toContain('created_at');
    expect(AUTOPG_META_COLUMNS).toContain('last_updated');
    // pgserve_meta columns belong to a different table; never overlap.
    expect(AUTOPG_META_COLUMNS).not.toContain('fingerprint');
    expect(AUTOPG_META_COLUMNS).not.toContain('database_name');
  });
});

describe('getBootstrapStatements', () => {
  test('returns an array of idempotent statements', () => {
    const statements = getBootstrapStatements();
    expect(Array.isArray(statements)).toBe(true);
    expect(statements.length).toBeGreaterThanOrEqual(2); // table + at least 1 index
    for (const sql of statements) {
      expect(typeof sql).toBe('string');
      expect(sql.length).toBeGreaterThan(0);
    }
  });

  test('first statement creates the table with IF NOT EXISTS', () => {
    const [createTable] = getBootstrapStatements();
    expect(createTable).toMatch(/CREATE TABLE IF NOT EXISTS public\.autopg_meta/);
  });

  test('table + indexes are schema-qualified to public', () => {
    const sql = getBootstrapStatements().join(';');
    expect(sql).toContain('public.autopg_meta');
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS autopg_meta(?!\w)/);
    expect(sql).not.toMatch(/ON autopg_meta(?!\w)/);
  });

  test('table SQL declares the expected primary key + types', () => {
    const [createTable] = getBootstrapStatements();
    expect(createTable).toMatch(/slug\s+TEXT\s+PRIMARY KEY/);
    expect(createTable).toMatch(/manifest_path\s+TEXT\s+NOT NULL/);
    expect(createTable).toMatch(/locked_roots\s+JSONB\s+NOT NULL/);
    expect(createTable).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
    expect(createTable).toMatch(/last_updated\s+TIMESTAMPTZ\s+NOT NULL DEFAULT now\(\)/);
  });

  test('every index uses CREATE INDEX IF NOT EXISTS for idempotency', () => {
    const indexStatements = getBootstrapStatements().slice(1);
    expect(indexStatements.length).toBeGreaterThan(0);
    for (const sql of indexStatements) {
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
    }
  });

  test('last_updated index exists (doctor + audit can sort by recency)', () => {
    const sql = getBootstrapStatements().join(';');
    expect(sql).toContain('autopg_meta_last_updated_idx');
    expect(sql).toContain('(last_updated)');
  });
});

describe('getBootstrapSQL', () => {
  test('joins statements with semicolons + newlines and ends with ";\\n"', () => {
    const sql = getBootstrapSQL();
    expect(sql.endsWith(';\n')).toBe(true);
    expect(sql).toContain(';\n\n');
  });
});

describe('bootstrapAutopgMeta', () => {
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
    const ran = await bootstrapAutopgMeta(client);
    expect(ran).toEqual(getBootstrapStatements());
    expect(client.calls).toEqual(getBootstrapStatements());
  });

  test('rejects clients that do not expose an async query()', async () => {
    let caught;
    try {
      await bootstrapAutopgMeta(null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);

    let caught2;
    try {
      await bootstrapAutopgMeta({ query: 'not-a-function' });
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
      await bootstrapAutopgMeta(client);
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
