/**
 * API contract tests — public isolation APIs are generic and have no domain dependencies
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';

// Import ONLY from the isolation barrel — simulates external consumer
import {
  initCatalog,
  getCatalogEntry,
  upsertCatalogEntry,
  provisionSchema,
  getConnectionInfo,
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

// ─── initCatalog + getCatalogEntry (DB-bound) ─────────────────────────────────

test('api-contract - initCatalog creates table', async () => {
  await initCatalog(sql);
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = 'pgserve_isolation_catalog'
  `;
  expect(rows.length).toBe(1);
});

test('api-contract - getCatalogEntry returns null for missing name', async () => {
  const result = await getCatalogEntry(sql, '__no_such_entry__');
  expect(result).toBeNull();
});

test('api-contract - upsertCatalogEntry then getCatalogEntry round-trips', async () => {
  await upsertCatalogEntry(sql, {
    name: 'contract-entry',
    schemaName: 'contract_schema',
    roleName: 'contract_role',
    policyVersion: 1,
  });

  const entry = await getCatalogEntry(sql, 'contract-entry');
  expect(entry.name).toBe('contract-entry');
  expect(entry.schema_name).toBe('contract_schema');
  expect(entry.role_name).toBe('contract_role');
});

// ─── provisionSchema ────────────────────────────────────────────────────────

test('api-contract - provisionSchema returns expected shape', async () => {
  const result = await provisionSchema(sql, {
    name: 'shape-test',
    schemaName: 'shape_test_schema',
    roleName: 'shape_test_role',
  });
  expect(result).toHaveProperty('schemaName');
  expect(result).toHaveProperty('roleName');
  expect(result).toHaveProperty('created');
  expect(typeof result.schemaName).toBe('string');
  expect(typeof result.roleName).toBe('string');
  expect(typeof result.created).toBe('boolean');
});

// ─── getConnectionInfo ─────────────────────────────────────────────────────

test('api-contract - getConnectionInfo returns expected shape after provision', async () => {
  await provisionSchema(sql, {
    name: 'conn-info',
    schemaName: 'conn_info_schema',
    roleName: 'conn_info_role',
  });

  const info = await getConnectionInfo(sql, 'conn-info');
  expect(info).not.toBeNull();
  expect(info.schemaName).toBe('conn_info_schema');
  expect(info.roleName).toBe('conn_info_role');
  expect(typeof info.searchPath).toBe('string');
  expect(info.searchPath).toContain('conn_info_schema');
  expect(info.connectionOptions).toBeDefined();
  expect(info.connectionOptions.searchPath).toBe(info.searchPath);
});

test('api-contract - getConnectionInfo returns null for unprovisioned name', async () => {
  const info = await getConnectionInfo(sql, '__unprovisioned__');
  expect(info).toBeNull();
});

// ─── No domain-specific imports ──────────────────────────────────────────────

test('api-contract - isolation module has no domain-specific imports', async () => {
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

test('api-contract - no normalizeAppId export (consumer defines naming)', async () => {
  const barrel = await import('../../src/isolation/index.js');
  expect(barrel.normalizeAppId).toBeUndefined();
});
