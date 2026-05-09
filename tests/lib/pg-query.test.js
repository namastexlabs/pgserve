/**
 * Tests for the shared psql shellout primitive (singleton G3 foundation).
 *
 * Locks the validation surface + identifier/literal-quoting contract.
 * Real psql round-trips are exercised by integration tests that spin
 * up a postgres in CI.
 */

import { test, expect, describe } from 'bun:test';
import { pgQuery, quoteIdent, quoteLiteral, PG_QUERY_DEFAULTS } from '../../src/lib/pg-query.js';

describe('pgQuery — input validation', () => {
  test('rejects empty / non-string sql before shellout', () => {
    expect(() => pgQuery({ sql: '' })).toThrow(TypeError);
    expect(() => pgQuery({ sql: null })).toThrow(TypeError);
    expect(() => pgQuery({})).toThrow(TypeError);
    expect(() => pgQuery()).toThrow(TypeError);
  });
});

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

  test('handles already-quoted identifier conservatively (extra escape, still valid SQL)', () => {
    // `"foo"` → `""foo""` wrapped → `"""foo"""` — escaping is symmetric.
    expect(quoteIdent('"foo"')).toBe('"""foo"""');
  });
});

describe('quoteLiteral', () => {
  test('wraps in single quotes', () => {
    expect(quoteLiteral('demo')).toBe("'demo'");
  });

  test("escapes embedded apostrophes (SQL injection guard)", () => {
    expect(quoteLiteral("o'reilly")).toBe("'o''reilly'");
  });

  test('coerces non-string input', () => {
    expect(quoteLiteral(42)).toBe("'42'");
    expect(quoteLiteral(null)).toBe("'null'");
  });
});

describe('PG_QUERY_DEFAULTS', () => {
  test('canonical surface', () => {
    expect(PG_QUERY_DEFAULTS.port).toBe(5432);
    expect(PG_QUERY_DEFAULTS.host).toBe('127.0.0.1');
    expect(PG_QUERY_DEFAULTS.user).toBe('postgres');
    expect(PG_QUERY_DEFAULTS.db).toBe('postgres');
  });

  test('is frozen', () => {
    expect(Object.isFrozen(PG_QUERY_DEFAULTS)).toBe(true);
  });
});
