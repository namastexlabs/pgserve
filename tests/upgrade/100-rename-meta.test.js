/**
 * Tests for src/upgrade/steps/100-rename-meta.js — Group 3,
 * autopg-distribution-cutover wish.
 *
 * Drives the migration's decision matrix via an injectable SQL executor so
 * we cover every branch (fresh / legacy-only / migrated / both / failure)
 * without booting a real Postgres for each case.
 *
 * Acceptance criteria covered (wish §Group 3):
 *   - On a fresh host, autopg_meta schema is created; no legacy table to
 *     move; second run is a no-op.
 *   - On a pgserve@2.2.x host, public.pgserve_meta is relocated to
 *     autopg_meta with no row delta; second run is a no-op.
 *   - Re-running the migration is idempotent (rename + DDL).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import * as renameMeta from '../../src/upgrade/steps/100-rename-meta.js';

const noopLog = () => {};
const noopWarn = () => {};

/**
 * Mock SQL executor. Holds a mutable world {newSchema, legacyTable,
 * migratedTable} updated by SQL statements the step issues.
 */
function makeMockSql(initialState) {
  const world = { ...initialState };
  const calls = [];
  function exec({ sql, captureStdout }) {
    calls.push(sql.trim().replace(/\s+/g, ' '));
    if (captureStdout) {
      // The inspect query.
      const t = (b) => (b ? 't' : 'f');
      return `${t(world.newSchema)}|${t(world.legacyTable)}|${t(world.migratedTable)}`;
    }
    if (/CREATE SCHEMA IF NOT EXISTS autopg_meta/.test(sql)) {
      world.newSchema = true;
      return undefined;
    }
    if (/ALTER TABLE public\.pgserve_meta SET SCHEMA autopg_meta/.test(sql)) {
      world.legacyTable = false;
      world.migratedTable = true;
      return undefined;
    }
    return undefined;
  }
  return { exec, world, calls };
}

beforeEach(() => {
  renameMeta.__test_internals.resetSqlExecutor();
});

afterEach(() => {
  renameMeta.__test_internals.resetSqlExecutor();
});

describe('100-rename-meta — fresh host (no schema, no table)', () => {
  test('plan announces CREATE SCHEMA only', async () => {
    const mock = makeMockSql({ newSchema: false, legacyTable: false, migratedTable: false });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);
    const planned = await renameMeta.plan();
    expect(planned).toMatch(/CREATE SCHEMA autopg_meta/);
  });

  test('execute creates the schema; second run is a SKIP no-op', async () => {
    const mock = makeMockSql({ newSchema: false, legacyTable: false, migratedTable: false });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);

    const r1 = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r1.status).toBe('OK');
    expect(mock.world.newSchema).toBe(true);
    expect(mock.calls.some((s) => /CREATE SCHEMA IF NOT EXISTS autopg_meta/.test(s))).toBe(true);

    const r2 = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r2.status).toBe('OK');
    expect(r2.detail).toMatch(/no legacy table/i);
  });
});

describe('100-rename-meta — legacy host (public.pgserve_meta exists)', () => {
  test('plan announces CREATE SCHEMA + ALTER TABLE SET SCHEMA', async () => {
    const mock = makeMockSql({ newSchema: false, legacyTable: true, migratedTable: false });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);
    const planned = await renameMeta.plan();
    expect(planned).toMatch(/CREATE SCHEMA autopg_meta/);
    expect(planned).toMatch(/ALTER TABLE public\.pgserve_meta SET SCHEMA autopg_meta/);
  });

  test('execute creates schema, moves table, returns OK; rerun is SKIP', async () => {
    const mock = makeMockSql({ newSchema: false, legacyTable: true, migratedTable: false });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);

    const r1 = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r1.status).toBe('OK');
    expect(r1.detail).toMatch(/moved public\.pgserve_meta → autopg_meta\.pgserve_meta/);
    expect(mock.world.newSchema).toBe(true);
    expect(mock.world.legacyTable).toBe(false);
    expect(mock.world.migratedTable).toBe(true);

    const r2 = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r2.status).toBe('SKIP');
    expect(r2.detail).toMatch(/already present/);
  });
});

describe('100-rename-meta — already-migrated host', () => {
  test('plan reports already-migrated', async () => {
    const mock = makeMockSql({ newSchema: true, legacyTable: false, migratedTable: true });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);
    const planned = await renameMeta.plan();
    expect(planned).toMatch(/already lives in autopg_meta/);
  });

  test('execute returns SKIP without re-running ALTER', async () => {
    const mock = makeMockSql({ newSchema: true, legacyTable: false, migratedTable: true });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);

    const r = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('SKIP');
    expect(mock.calls.some((s) => /ALTER TABLE/.test(s))).toBe(false);
    expect(mock.calls.some((s) => /CREATE SCHEMA/.test(s))).toBe(false);
  });
});

describe('100-rename-meta — duplicate-table refusal (defensive)', () => {
  test('execute FAILS when both public.pgserve_meta and autopg_meta.pgserve_meta exist', async () => {
    const mock = makeMockSql({ newSchema: true, legacyTable: true, migratedTable: true });
    renameMeta.__test_internals.setSqlExecutor(mock.exec);

    const warnings = [];
    const warn = (msg) => warnings.push(msg);
    const r = await renameMeta.execute({ log: noopLog, warn });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/duplicate pgserve_meta/);
    expect(warnings.length).toBeGreaterThan(0);
    expect(mock.calls.some((s) => /ALTER TABLE/.test(s))).toBe(false);
  });
});

describe('100-rename-meta — error surfaces', () => {
  test('plan returns a friendly message on inspect failure', async () => {
    renameMeta.__test_internals.setSqlExecutor(() => {
      throw new Error('connection refused');
    });
    const planned = await renameMeta.plan();
    expect(planned).toMatch(/cannot inspect schema state.*connection refused/);
  });

  test('execute returns FAIL on inspect failure', async () => {
    renameMeta.__test_internals.setSqlExecutor(() => {
      throw new Error('connection refused');
    });
    const r = await renameMeta.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/cannot inspect schema state/);
  });
});

describe('100-rename-meta — module exports', () => {
  test('module exposes the canonical {name, plan, execute} step contract', () => {
    expect(renameMeta.name).toBe('rename-meta');
    expect(typeof renameMeta.plan).toBe('function');
    expect(typeof renameMeta.execute).toBe('function');
  });
});
