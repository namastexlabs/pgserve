/**
 * Catalog tests — pgserve_app_isolation_catalog CRUD + idempotent init
 *
 * Uses an embedded PostgreSQL instance (via PostgresManager) so the tests
 * are self-contained and have no external dependency.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog, getCatalogEntry, upsertCatalogEntry } from '../../src/isolation/catalog.js';

const pgPort = 15550;
let pgManager;
let sql;

beforeAll(async () => {
  pgManager = new PostgresManager({
    port: pgPort,
    logger: createLogger({ level: 'error' }),
  });
  await pgManager.start();

  const { SQL } = await import('bun');
  sql = new SQL({
    hostname: '127.0.0.1',
    port: pgPort,
    database: 'postgres',
    username: 'postgres',
    password: 'postgres',
    max: 3,
    idleTimeout: 10,
    connectionTimeout: 5,
  });

  await initCatalog(sql);
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

test('catalog - table exists after initCatalog', async () => {
  const result = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pgserve_app_isolation_catalog'
  `;
  expect(result.length).toBe(1);
});

test('catalog - initCatalog is idempotent (can be called multiple times)', async () => {
  // Call init twice — should not throw
  await initCatalog(sql);
  await initCatalog(sql);

  const result = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pgserve_app_isolation_catalog'
  `;
  expect(result.length).toBe(1);
});

test('catalog - getCatalogEntry returns null for unknown appId', async () => {
  const entry = await getCatalogEntry(sql, 'no-such-app');
  expect(entry).toBeNull();
});

test('catalog - upsertCatalogEntry inserts a new entry', async () => {
  await upsertCatalogEntry(sql, {
    appId: 'test-app-1',
    schemaName: 'app_test_app_1',
    roleName: 'app_test_app_1_role',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'test-app-1');
  expect(entry).not.toBeNull();
  expect(entry.app_id).toBe('test-app-1');
  expect(entry.schema_name).toBe('app_test_app_1');
  expect(entry.role_name).toBe('app_test_app_1_role');
  expect(entry.policy_version).toBe(1);
  expect(entry.created_at).toBeDefined();
  expect(entry.updated_at).toBeDefined();
});

test('catalog - upsertCatalogEntry updates an existing entry (no duplicates)', async () => {
  // Insert first
  await upsertCatalogEntry(sql, {
    appId: 'test-app-upsert',
    schemaName: 'app_test_app_upsert',
    roleName: 'app_test_app_upsert_role',
    policyVersion: 1,
  });

  // Upsert again with same appId
  await upsertCatalogEntry(sql, {
    appId: 'test-app-upsert',
    schemaName: 'app_test_app_upsert',
    roleName: 'app_test_app_upsert_role',
    policyVersion: 2,
  });

  // Check there is only ONE row for this appId
  const rows = await sql`
    SELECT * FROM pgserve_app_isolation_catalog WHERE app_id = 'test-app-upsert'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0].policy_version).toBe(2);
});

test('catalog - getCatalogEntry returns all expected columns', async () => {
  await upsertCatalogEntry(sql, {
    appId: 'test-app-columns',
    schemaName: 'app_test_app_columns',
    roleName: 'app_test_app_columns_role',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'test-app-columns');
  expect(entry).toHaveProperty('id');
  expect(entry).toHaveProperty('app_id');
  expect(entry).toHaveProperty('schema_name');
  expect(entry).toHaveProperty('role_name');
  expect(entry).toHaveProperty('policy_version');
  expect(entry).toHaveProperty('created_at');
  expect(entry).toHaveProperty('updated_at');
});
