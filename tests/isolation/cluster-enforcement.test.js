/**
 * Cluster enforcement tests — concurrent provisioning + cross-schema denial
 *
 * Verifies:
 * 1. Enforcement works correctly after concurrent provisioning
 * 2. Cross-schema denial: role A cannot read role B's tables
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionSchema } from '../../src/isolation/provision.js';
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
  const target = { name: 'cluster', schemaName: 'cluster_schema', roleName: 'cluster_role' };

  // Concurrent provisionSchema calls (with enforceDenyByDefault off so we control timing)
  const results = await Promise.all([
    provisionSchema(sql, target, { enforceDenyByDefault: false }),
    provisionSchema(sql, target, { enforceDenyByDefault: false }),
    provisionSchema(sql, target, { enforceDenyByDefault: false }),
    provisionSchema(sql, target, { enforceDenyByDefault: false }),
    provisionSchema(sql, target, { enforceDenyByDefault: false }),
  ]);

  for (const r of results) {
    expect(r.schemaName).toBe('cluster_schema');
    expect(r.roleName).toBe('cluster_role');
  }

  // Now apply enforcement — must not error
  await expect(applyDenyByDefault(sql, { schemaName: 'cluster_schema', roleName: 'cluster_role' })).resolves.toBeUndefined();

  // Confirm enforcement actually applied (role has USAGE)
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('cluster_role', 'cluster_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('cluster-enforcement - cross-schema denial: role-x cannot read role-y tables', async () => {
  // Provision two schemas with full enforcement
  await provisionSchema(sql, { name: 'cluster-x', schemaName: 'cluster_x_schema', roleName: 'cluster_x_role' }, { enforceDenyByDefault: false });
  await provisionSchema(sql, { name: 'cluster-y', schemaName: 'cluster_y_schema', roleName: 'cluster_y_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'cluster_x_schema', roleName: 'cluster_x_role' });
  await applyDenyByDefault(sql, { schemaName: 'cluster_y_schema', roleName: 'cluster_y_role' });

  // Create a table in cluster-x's schema as superuser (simulating data)
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS cluster_x_schema.secret_data (id SERIAL PRIMARY KEY, value TEXT)`);
  await sql.unsafe(`INSERT INTO cluster_x_schema.secret_data (value) VALUES ('secret') ON CONFLICT DO NOTHING`);

  // cluster_y_role should NOT be able to SELECT from cluster_x's table
  const rows = await sql.unsafe(`
    SELECT has_table_privilege('cluster_y_role', 'cluster_x_schema.secret_data', 'SELECT') AS can_select
  `);
  expect(rows[0].can_select).toBe(false);
});

test('cluster-enforcement - provisionSchema with enforceDenyByDefault=true auto-applies enforcement', async () => {
  const result = await provisionSchema(sql, { name: 'auto-enforce', schemaName: 'auto_enforce_schema', roleName: 'auto_enforce_role' });
  expect(result.schemaName).toBe('auto_enforce_schema');
  expect(result.roleName).toBe('auto_enforce_role');

  // Role should have USAGE because enforcement was auto-applied
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('auto_enforce_role', 'auto_enforce_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('cluster-enforcement - cross-schema denial holds after concurrent provisioning', async () => {
  // Concurrently provision two different schemas
  await Promise.all([
    provisionSchema(sql, { name: 'race-a', schemaName: 'race_a_schema', roleName: 'race_a_role' }),
    provisionSchema(sql, { name: 'race-b', schemaName: 'race_b_schema', roleName: 'race_b_role' }),
  ]);

  // race_b_role should not have USAGE on race_a_schema
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('race_b_role', 'race_a_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});
