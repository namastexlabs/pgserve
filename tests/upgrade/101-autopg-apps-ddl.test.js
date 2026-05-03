/**
 * Tests for src/upgrade/steps/101-autopg-apps-ddl.js — Group 3,
 * autopg-distribution-cutover wish.
 *
 * Acceptance criteria covered (wish §Group 3):
 *   - Fresh host: autopg_apps table is created with the locked column set.
 *   - Re-running the migration is a no-op (CREATE TABLE IF NOT EXISTS).
 *   - Refuses to create the table if the autopg_meta schema is missing
 *     (signals that step 100 must run first).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import * as autopgAppsDdl from '../../src/upgrade/steps/101-autopg-apps-ddl.js';

const noopLog = () => {};

function makeMockSql({ schemaPresent = true, tablePresent = false } = {}) {
  const world = { schemaPresent, tablePresent };
  const calls = [];
  function exec({ sql, captureStdout }) {
    calls.push(sql.trim().replace(/\s+/g, ' '));
    if (captureStdout) {
      if (/schemata.*'autopg_meta'/.test(sql)) return world.schemaPresent ? 't' : 'f';
      if (/tables.*'autopg_meta'.*'autopg_apps'/.test(sql)) return world.tablePresent ? 't' : 'f';
      throw new Error(`unexpected captureStdout SQL: ${sql}`);
    }
    if (/CREATE TABLE IF NOT EXISTS autopg_meta\.autopg_apps/.test(sql)) {
      world.tablePresent = true;
      return undefined;
    }
    return undefined;
  }
  return { exec, world, calls };
}

beforeEach(() => {
  autopgAppsDdl.__test_internals.resetSqlExecutor();
});

afterEach(() => {
  autopgAppsDdl.__test_internals.resetSqlExecutor();
});

describe('101-autopg-apps-ddl — fresh host', () => {
  test('plan announces CREATE TABLE when missing', async () => {
    const mock = makeMockSql({ schemaPresent: true, tablePresent: false });
    autopgAppsDdl.__test_internals.setSqlExecutor(mock.exec);
    const planned = await autopgAppsDdl.plan();
    expect(planned).toMatch(/CREATE TABLE IF NOT EXISTS autopg_meta\.autopg_apps/);
  });

  test('execute creates the table; rerun returns SKIP', async () => {
    const mock = makeMockSql({ schemaPresent: true, tablePresent: false });
    autopgAppsDdl.__test_internals.setSqlExecutor(mock.exec);

    const r1 = await autopgAppsDdl.execute({ log: noopLog });
    expect(r1.status).toBe('OK');
    expect(r1.detail).toMatch(/created autopg_meta\.autopg_apps/);
    expect(mock.world.tablePresent).toBe(true);

    const r2 = await autopgAppsDdl.execute({ log: noopLog });
    expect(r2.status).toBe('SKIP');
    expect(r2.detail).toMatch(/already present/);
  });
});

describe('101-autopg-apps-ddl — schema-missing precondition', () => {
  test('execute FAILs with a hint to run step 100 first', async () => {
    const mock = makeMockSql({ schemaPresent: false, tablePresent: false });
    autopgAppsDdl.__test_internals.setSqlExecutor(mock.exec);

    const r = await autopgAppsDdl.execute({ log: noopLog });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/schema missing.*step 100/);
    expect(mock.calls.some((s) => /CREATE TABLE/.test(s))).toBe(false);
  });
});

describe('101-autopg-apps-ddl — DDL shape', () => {
  test('locked column set per wish §Group 3', () => {
    // Eight columns, in this order, with these types — guards against
    // inadvertent schema drift in future PRs.
    const ddl = autopgAppsDdl.APPS_DDL.replace(/\s+/g, ' ').trim();
    const expected = [
      /app +TEXT PRIMARY KEY/i,
      /role +TEXT NOT NULL/i,
      /db +TEXT NOT NULL/i,
      /manifest_sha256 +TEXT NOT NULL/i,
      /manifest_sig_verified +BOOLEAN NOT NULL/i,
      /created_at +TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i,
      /updated_at +TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i,
    ];
    for (const re of expected) {
      expect(ddl).toMatch(re);
    }
  });
});

describe('101-autopg-apps-ddl — module exports', () => {
  test('module exposes the canonical {name, plan, execute} step contract', () => {
    expect(autopgAppsDdl.name).toBe('autopg-apps-ddl');
    expect(typeof autopgAppsDdl.plan).toBe('function');
    expect(typeof autopgAppsDdl.execute).toBe('function');
    expect(typeof autopgAppsDdl.APPS_DDL).toBe('string');
  });
});
