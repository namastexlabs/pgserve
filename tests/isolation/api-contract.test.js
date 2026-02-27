/**
 * API contract tests — public isolation APIs work without genie-os dependencies
 *
 * Verifies:
 * 1. All public exports work without importing anything from genie-os
 * 2. normalizeAppId is a pure function (no I/O)
 * 3. getAppConnectionInfo returns expected shape
 * 4. isolation/index.js re-exports all public APIs
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';

// Import ONLY from the isolation barrel — simulates external consumer
import {
  normalizeAppId,
  initCatalog,
  getCatalogEntry,
  upsertCatalogEntry,
  provisionAppSchema,
  getAppConnectionInfo,
} from '../../src/isolation/index.js';

const pgPort = 15552;
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
    max: 5,
    idleTimeout: 10,
    connectionTimeout: 5,
  });

  await initCatalog(sql);
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

// ─── normalizeAppId (pure, no I/O) ────────────────────────────────────────────

test('api-contract - normalizeAppId is a pure function', () => {
  const result = normalizeAppId('my-app');
  expect(result).toEqual({
    schemaName: 'app_my_app',
    roleName: 'app_my_app_role',
  });
});

test('api-contract - normalizeAppId lowercases input', () => {
  const result = normalizeAppId('MYAPP');
  expect(result.schemaName).toBe('app_myapp');
  expect(result.roleName).toBe('app_myapp_role');
});

test('api-contract - normalizeAppId replaces hyphens with underscores', () => {
  const { schemaName, roleName } = normalizeAppId('khal-backend');
  expect(schemaName).toBe('app_khal_backend');
  expect(roleName).toBe('app_khal_backend_role');
});

test('api-contract - normalizeAppId collapses multiple separators', () => {
  const { schemaName } = normalizeAppId('my--app__test');
  expect(schemaName).toBe('app_my_app_test');
});

// ─── initCatalog + getCatalogEntry (DB-bound) ─────────────────────────────────

test('api-contract - initCatalog creates table', async () => {
  await initCatalog(sql); // idempotent
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'pgserve_app_isolation_catalog'
  `;
  expect(rows.length).toBe(1);
});

test('api-contract - getCatalogEntry returns null for missing appId', async () => {
  const result = await getCatalogEntry(sql, '__no_such_app__');
  expect(result).toBeNull();
});

test('api-contract - upsertCatalogEntry then getCatalogEntry round-trips', async () => {
  await upsertCatalogEntry(sql, {
    appId: 'contract-app',
    schemaName: 'app_contract_app',
    roleName: 'app_contract_app_role',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'contract-app');
  expect(entry.app_id).toBe('contract-app');
  expect(entry.schema_name).toBe('app_contract_app');
  expect(entry.role_name).toBe('app_contract_app_role');
});

// ─── provisionAppSchema ────────────────────────────────────────────────────────

test('api-contract - provisionAppSchema returns expected shape', async () => {
  const result = await provisionAppSchema(sql, 'shape-test');
  expect(result).toHaveProperty('schemaName');
  expect(result).toHaveProperty('roleName');
  expect(result).toHaveProperty('created');
  expect(typeof result.schemaName).toBe('string');
  expect(typeof result.roleName).toBe('string');
  expect(typeof result.created).toBe('boolean');
});

// ─── getAppConnectionInfo ─────────────────────────────────────────────────────

test('api-contract - getAppConnectionInfo returns expected shape after provision', async () => {
  await provisionAppSchema(sql, 'conn-info-app');

  const info = await getAppConnectionInfo(sql, 'conn-info-app');
  expect(info).not.toBeNull();
  expect(info.schemaName).toBe('app_conn_info_app');
  expect(info.roleName).toBe('app_conn_info_app_role');
  expect(typeof info.searchPath).toBe('string');
  expect(info.searchPath).toContain('app_conn_info_app');
  expect(info.connectionOptions).toBeDefined();
  expect(info.connectionOptions.searchPath).toBe(info.searchPath);
});

test('api-contract - getAppConnectionInfo returns null for unprovisioned appId', async () => {
  const info = await getAppConnectionInfo(sql, '__unprovisioned__');
  expect(info).toBeNull();
});

// ─── No genie-os imports ──────────────────────────────────────────────────────

test('api-contract - isolation module has no genie-os imports', async () => {
  // Dynamic import the module source and check it doesn't mention genie-os
  const fs = await import('fs');
  const path = await import('path');

  const isolationDir = path.join(import.meta.dirname, '../../src/isolation');
  const files = fs.readdirSync(isolationDir).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const src = fs.readFileSync(path.join(isolationDir, file), 'utf-8');
    expect(src).not.toContain('genie-os');
    expect(src).not.toContain('@genie-os');
    expect(src).not.toContain('khal-app');
  }
});
