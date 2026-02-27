/**
 * Cluster enforcement tests — concurrent provisioning + cross-app denial
 *
 * Verifies:
 * 1. Enforcement works correctly after concurrent provisioning
 * 2. Cross-app denial: app A cannot read app B's tables
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionAppSchema } from '../../src/isolation/provision.js';
import { applyDenyByDefault } from '../../src/isolation/enforcement.js';

const pgPort = 15555;
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
    max: 20,
    idleTimeout: 10,
    connectionTimeout: 5,
  });

  await initCatalog(sql);
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

test('cluster-enforcement - concurrent provisioning + enforcement does not error', async () => {
  const appId = 'cluster-app';

  // Concurrent provisionAppSchema calls (with enforceDenyByDefault off so we control timing)
  const results = await Promise.all([
    provisionAppSchema(sql, appId, { enforceDenyByDefault: false }),
    provisionAppSchema(sql, appId, { enforceDenyByDefault: false }),
    provisionAppSchema(sql, appId, { enforceDenyByDefault: false }),
    provisionAppSchema(sql, appId, { enforceDenyByDefault: false }),
    provisionAppSchema(sql, appId, { enforceDenyByDefault: false }),
  ]);

  for (const r of results) {
    expect(r.schemaName).toBe('app_cluster_app');
    expect(r.roleName).toBe('app_cluster_app_role');
  }

  // Now apply enforcement — must not error
  await expect(applyDenyByDefault(sql, appId)).resolves.toBeUndefined();

  // Confirm enforcement actually applied (role has USAGE)
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_cluster_app_role', 'app_cluster_app', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('cluster-enforcement - cross-app denial: app-x cannot read app-y tables', async () => {
  // Provision two apps with full enforcement
  await provisionAppSchema(sql, 'cluster-x', { enforceDenyByDefault: false });
  await provisionAppSchema(sql, 'cluster-y', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'cluster-x');
  await applyDenyByDefault(sql, 'cluster-y');

  // Create a table in cluster-x's schema as superuser (simulating app-x data)
  // Use fully-qualified names to avoid changing the session search_path
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS app_cluster_x.secret_data (id SERIAL PRIMARY KEY, value TEXT)`);
  await sql.unsafe(`INSERT INTO app_cluster_x.secret_data (value) VALUES ('secret') ON CONFLICT DO NOTHING`);

  // cluster-y role should NOT be able to SELECT from cluster-x's table
  // We verify at the privilege level since we can't log in as the role
  const rows = await sql.unsafe(`
    SELECT has_table_privilege('app_cluster_y_role', 'app_cluster_x.secret_data', 'SELECT') AS can_select
  `);
  expect(rows[0].can_select).toBe(false);
});

test('cluster-enforcement - provisionAppSchema with enforceDenyByDefault=true auto-applies enforcement', async () => {
  // This uses the default (enforceDenyByDefault=true in provisionAppSchema)
  const result = await provisionAppSchema(sql, 'auto-enforce');
  expect(result.schemaName).toBe('app_auto_enforce');
  expect(result.roleName).toBe('app_auto_enforce_role');

  // Role should have USAGE because enforcement was auto-applied
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_auto_enforce_role', 'app_auto_enforce', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('cluster-enforcement - cross-app denial holds after concurrent provisioning', async () => {
  // Concurrently provision two different apps
  await Promise.all([
    provisionAppSchema(sql, 'race-a'),
    provisionAppSchema(sql, 'race-b'),
  ]);

  // app_race_b_role should not have USAGE on app_race_a schema
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_race_b_role', 'app_race_a', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});
