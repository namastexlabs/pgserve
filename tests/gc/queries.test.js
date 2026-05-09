/**
 * Tests for the psql shellout helpers (singleton G3 gc verb support).
 *
 * Deliberately scoped to the SQL-shape + identifier/literal-quoting
 * surface. The actual psql round-trip is exercised by integration tests
 * that spin up a real postgres in CI (tests/integration/gc-provision.test.sh).
 */

import { test, expect, describe } from 'bun:test';
import {
  selectMetaRows,
  selectExistingDbs,
  selectActiveDbs,
  dropDatabase,
  deleteMetaRow,
  __testInternals,
} from '../../src/gc/queries.js';
import { pgQuery } from '../../src/lib/pg-query.js';

const { quoteIdent, quoteLiteral, SYSTEM_DBS, DEFAULT_PORT } = __testInternals;

describe('quoteIdent', () => {
  test('wraps in double quotes', () => {
    expect(quoteIdent('pgserve_x')).toBe('"pgserve_x"');
  });

  test('escapes embedded double quotes', () => {
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });

  test('coerces non-string input rather than crashing', () => {
    expect(quoteIdent(42)).toBe('"42"');
  });
});

describe('quoteLiteral', () => {
  test('wraps in single quotes', () => {
    expect(quoteLiteral('demo')).toBe("'demo'");
  });

  test("escapes embedded apostrophes (SQL injection guard)", () => {
    expect(quoteLiteral("o'reilly")).toBe("'o''reilly'");
  });
});

describe('SYSTEM_DBS', () => {
  test('contains the postgres template DBs we never gc', () => {
    expect(SYSTEM_DBS.has('template0')).toBe(true);
    expect(SYSTEM_DBS.has('template1')).toBe(true);
    expect(SYSTEM_DBS.has('postgres')).toBe(true);
  });
});

describe('DEFAULT_PORT', () => {
  test('canonical postgres port', () => {
    expect(DEFAULT_PORT).toBe(5432);
  });
});

describe('input validation (no postgres needed)', () => {
  test('pgQuery rejects empty / non-string sql', () => {
    expect(() => pgQuery({ sql: '' })).toThrow(TypeError);
    expect(() => pgQuery({ sql: null })).toThrow(TypeError);
    expect(() => pgQuery({})).toThrow(TypeError);
  });

  test('dropDatabase refuses an empty database name', () => {
    expect(() => dropDatabase({ database: '' })).toThrow(/refusing to drop/);
  });

  test('dropDatabase refuses to drop a system DB', () => {
    expect(() => dropDatabase({ database: 'template0' })).toThrow(/refusing to drop/);
    expect(() => dropDatabase({ database: 'template1' })).toThrow(/refusing to drop/);
    expect(() => dropDatabase({ database: 'postgres' })).toThrow(/refusing to drop/);
  });

  test('deleteMetaRow rejects empty fingerprint', () => {
    expect(() => deleteMetaRow({ fingerprint: '' })).toThrow(TypeError);
    expect(() => deleteMetaRow({})).toThrow(TypeError);
  });

  // The selectMetaRows / selectExistingDbs / selectActiveDbs functions
  // are shellout-driven; their behavior under "psql is not on PATH" or
  // "host has no postgres listening on 5432" is host-dependent. We do
  // not lock those error shapes here — integration tests cover them
  // when a real postgres is up.
  test('selectMetaRows / selectExistingDbs / selectActiveDbs are exported callables', () => {
    expect(typeof selectMetaRows).toBe('function');
    expect(typeof selectExistingDbs).toBe('function');
    expect(typeof selectActiveDbs).toBe('function');
  });
});
