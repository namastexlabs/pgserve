/**
 * Provision tests — provisionAppSchema idempotency + concurrency
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionAppSchema } from '../../src/isolation/provision.js';
import { normalizeAppId } from '../../src/isolation/naming.js';

const pgPort = 15551;
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
    max: 10,
    idleTimeout: 10,
    connectionTimeout: 5,
  });

  await initCatalog(sql);
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

test('provision - creates schema and role for new appId', async () => {
  const result = await provisionAppSchema(sql, 'myapp');
  expect(result.schemaName).toBe('app_myapp');
  expect(result.roleName).toBe('app_myapp_role');
  expect(result.created).toBe(true);

  // Verify schema actually exists in PG
  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = 'app_myapp'
  `;
  expect(schemas.length).toBe(1);

  // Verify role actually exists in PG
  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = 'app_myapp_role'
  `;
  expect(roles.length).toBe(1);
});

test('provision - is idempotent (same appId returns created=false on second call)', async () => {
  const first = await provisionAppSchema(sql, 'idempotent-app');
  expect(first.created).toBe(true);

  const second = await provisionAppSchema(sql, 'idempotent-app');
  expect(second.schemaName).toBe(first.schemaName);
  expect(second.roleName).toBe(first.roleName);
  expect(second.created).toBe(false);

  // Should still be only one entry in catalog
  const { getCatalogEntry } = await import('../../src/isolation/catalog.js');
  const entry = await getCatalogEntry(sql, 'idempotent-app');
  expect(entry).not.toBeNull();
  expect(entry.app_id).toBe('idempotent-app');
});

test('provision - no duplicate schemas or roles after repeated calls', async () => {
  const appId = 'repeat-app';
  await provisionAppSchema(sql, appId);
  await provisionAppSchema(sql, appId);
  await provisionAppSchema(sql, appId);

  const { schemaName, roleName } = normalizeAppId(appId);

  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = ${schemaName}
  `;
  expect(schemas.length).toBe(1);

  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = ${roleName}
  `;
  expect(roles.length).toBe(1);
});

test('provision - concurrent calls for same appId do not cause race condition', async () => {
  const appId = 'concurrent-app';

  // Fire 5 concurrent provision calls
  const results = await Promise.all([
    provisionAppSchema(sql, appId),
    provisionAppSchema(sql, appId),
    provisionAppSchema(sql, appId),
    provisionAppSchema(sql, appId),
    provisionAppSchema(sql, appId),
  ]);

  // All must return valid names (no errors thrown)
  for (const r of results) {
    expect(r.schemaName).toBe('app_concurrent_app');
    expect(r.roleName).toBe('app_concurrent_app_role');
  }

  // Exactly one schema and one role
  const { schemaName, roleName } = normalizeAppId(appId);
  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = ${schemaName}
  `;
  expect(schemas.length).toBe(1);

  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = ${roleName}
  `;
  expect(roles.length).toBe(1);
});

test('provision - normalizes appId with hyphens and uppercase', async () => {
  const result = await provisionAppSchema(sql, 'My-App-2');
  expect(result.schemaName).toBe('app_my_app_2');
  expect(result.roleName).toBe('app_my_app_2_role');
});
