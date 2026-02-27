/**
 * Provision tests — provisionSchema idempotency + concurrency
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog, getCatalogEntry } from '../../src/isolation/catalog.js';
import { provisionSchema } from '../../src/isolation/provision.js';

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

test('provision - creates schema and role', async () => {
  const result = await provisionSchema(sql, {
    name: 'myapp',
    schemaName: 'myapp_schema',
    roleName: 'myapp_role',
  });
  expect(result.schemaName).toBe('myapp_schema');
  expect(result.roleName).toBe('myapp_role');
  expect(result.created).toBe(true);

  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = 'myapp_schema'
  `;
  expect(schemas.length).toBe(1);

  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = 'myapp_role'
  `;
  expect(roles.length).toBe(1);
});

test('provision - is idempotent (same name returns created=false)', async () => {
  const first = await provisionSchema(sql, {
    name: 'idempotent',
    schemaName: 'idempotent_schema',
    roleName: 'idempotent_role',
  });
  expect(first.created).toBe(true);

  const second = await provisionSchema(sql, {
    name: 'idempotent',
    schemaName: 'idempotent_schema',
    roleName: 'idempotent_role',
  });
  expect(second.schemaName).toBe(first.schemaName);
  expect(second.roleName).toBe(first.roleName);
  expect(second.created).toBe(false);

  const entry = await getCatalogEntry(sql, 'idempotent');
  expect(entry).not.toBeNull();
  expect(entry.name).toBe('idempotent');
});

test('provision - no duplicate schemas or roles after repeated calls', async () => {
  const target = { name: 'repeat', schemaName: 'repeat_schema', roleName: 'repeat_role' };
  await provisionSchema(sql, target);
  await provisionSchema(sql, target);
  await provisionSchema(sql, target);

  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = 'repeat_schema'
  `;
  expect(schemas.length).toBe(1);

  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = 'repeat_role'
  `;
  expect(roles.length).toBe(1);
});

test('provision - concurrent calls do not cause race condition', async () => {
  const target = { name: 'concurrent', schemaName: 'concurrent_schema', roleName: 'concurrent_role' };

  const results = await Promise.all([
    provisionSchema(sql, target),
    provisionSchema(sql, target),
    provisionSchema(sql, target),
    provisionSchema(sql, target),
    provisionSchema(sql, target),
  ]);

  for (const r of results) {
    expect(r.schemaName).toBe('concurrent_schema');
    expect(r.roleName).toBe('concurrent_role');
  }

  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name = 'concurrent_schema'
  `;
  expect(schemas.length).toBe(1);

  const roles = await sql`
    SELECT rolname FROM pg_roles WHERE rolname = 'concurrent_role'
  `;
  expect(roles.length).toBe(1);
});

test('provision - consumer controls naming (no imposed convention)', async () => {
  const result = await provisionSchema(sql, {
    name: 'anything',
    schemaName: 'my_custom_schema',
    roleName: 'my_custom_role',
  });
  expect(result.schemaName).toBe('my_custom_schema');
  expect(result.roleName).toBe('my_custom_role');
  expect(result.created).toBe(true);
});
