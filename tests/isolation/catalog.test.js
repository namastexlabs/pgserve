/**
 * Catalog tests — pgserve_isolation_catalog CRUD + idempotent init
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
    WHERE table_schema = 'public' AND table_name = 'pgserve_isolation_catalog'
  `;
  expect(result.length).toBe(1);
});

test('catalog - initCatalog is idempotent (can be called multiple times)', async () => {
  await initCatalog(sql);
  await initCatalog(sql);

  const result = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pgserve_isolation_catalog'
  `;
  expect(result.length).toBe(1);
});

test('catalog - getCatalogEntry returns null for unknown name', async () => {
  const entry = await getCatalogEntry(sql, 'no-such-entry');
  expect(entry).toBeNull();
});

test('catalog - upsertCatalogEntry inserts a new entry', async () => {
  await upsertCatalogEntry(sql, {
    name: 'test-1',
    schemaName: 'test_schema_1',
    roleName: 'test_role_1',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'test-1');
  expect(entry).not.toBeNull();
  expect(entry.name).toBe('test-1');
  expect(entry.schema_name).toBe('test_schema_1');
  expect(entry.role_name).toBe('test_role_1');
  expect(entry.policy_version).toBe(1);
  expect(entry.created_at).toBeDefined();
  expect(entry.updated_at).toBeDefined();
});

test('catalog - upsertCatalogEntry updates an existing entry (no duplicates)', async () => {
  await upsertCatalogEntry(sql, {
    name: 'test-upsert',
    schemaName: 'test_schema_upsert',
    roleName: 'test_role_upsert',
    policyVersion: 1,
  });

  await upsertCatalogEntry(sql, {
    name: 'test-upsert',
    schemaName: 'test_schema_upsert',
    roleName: 'test_role_upsert',
    policyVersion: 2,
  });

  const rows = await sql`
    SELECT * FROM pgserve_isolation_catalog WHERE name = 'test-upsert'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0].policy_version).toBe(2);
});

test('catalog - getCatalogEntry returns all expected columns', async () => {
  await upsertCatalogEntry(sql, {
    name: 'test-columns',
    schemaName: 'test_schema_columns',
    roleName: 'test_role_columns',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'test-columns');
  expect(entry).toHaveProperty('id');
  expect(entry).toHaveProperty('name');
  expect(entry).toHaveProperty('schema_name');
  expect(entry).toHaveProperty('role_name');
  expect(entry).toHaveProperty('policy_version');
  expect(entry).toHaveProperty('created_at');
  expect(entry).toHaveProperty('updated_at');
});
