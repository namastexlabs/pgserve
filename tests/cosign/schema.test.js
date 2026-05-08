/**
 * Tests for src/cosign/schema.js — additive `pgserve_meta` migration.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * No live postgres is required: `applyVerifiedColumns()` only needs an
 * object with an async `query()` method, so we drive it with a fake that
 * records the SQL. Confidence in the actual SQL idempotency lives in
 * Group 9's integration tests.
 */

import { describe, expect, test } from 'bun:test';

import {
  applyVerifiedColumns,
  getMigrationSQL,
  getMigrationStatements,
  isValidTier,
  VERIFIED_TIER_CHECK_NAME,
  VERIFIED_TIER_VALUES,
} from '../../src/cosign/schema.js';

class FakePgClient {
  constructor() {
    this.executed = [];
  }
  async query(sql) {
    this.executed.push(sql);
    return { rows: [] };
  }
}

describe('VERIFIED_TIER_VALUES contract', () => {
  test('lists exactly the four tiers from the wish', () => {
    expect([...VERIFIED_TIER_VALUES]).toEqual(['path', 'host_signed', 'self_signed', 'cosign_signed']);
  });

  test('isValidTier accepts every listed tier', () => {
    for (const t of VERIFIED_TIER_VALUES) expect(isValidTier(t)).toBe(true);
  });

  test('isValidTier rejects unknown tiers', () => {
    expect(isValidTier('something-else')).toBe(false);
    expect(isValidTier('')).toBe(false);
    expect(isValidTier(null)).toBe(false);
  });
});

describe('getMigrationStatements()', () => {
  const stmts = getMigrationStatements();

  test('emits 4 idempotent statements (3 ADD COLUMN + 1 DO-block CHECK)', () => {
    expect(stmts.length).toBe(4);
  });

  test('each ADD COLUMN uses IF NOT EXISTS for idempotency', () => {
    expect(stmts[0]).toContain('ADD COLUMN IF NOT EXISTS verified_at');
    expect(stmts[1]).toContain('ADD COLUMN IF NOT EXISTS verified_identity');
    expect(stmts[2]).toContain('ADD COLUMN IF NOT EXISTS verified_tier');
  });

  test('CHECK constraint names the canonical constant', () => {
    expect(stmts[3]).toContain(VERIFIED_TIER_CHECK_NAME);
  });

  test('CHECK constraint enumerates every tier literal', () => {
    for (const tier of VERIFIED_TIER_VALUES) {
      expect(stmts[3]).toContain(`'${tier}'`);
    }
  });
});

describe('getMigrationSQL()', () => {
  test('joins all statements into a single semicolon-terminated blob', () => {
    const sql = getMigrationSQL();
    expect(sql.trim().endsWith(';')).toBe(true);
    expect(sql).toContain('verified_at');
    expect(sql).toContain('verified_identity');
    expect(sql).toContain('verified_tier');
  });
});

describe('applyVerifiedColumns()', () => {
  test('issues each statement once, in order, on the supplied client', async () => {
    const fake = new FakePgClient();
    const issued = await applyVerifiedColumns(fake);
    expect(issued.length).toBe(4);
    expect(fake.executed).toEqual(issued);
  });

  test('refuses clients without a query() method', async () => {
    expect(applyVerifiedColumns(null)).rejects.toThrow(/query/);
    expect(applyVerifiedColumns({})).rejects.toThrow(/query/);
  });
});
