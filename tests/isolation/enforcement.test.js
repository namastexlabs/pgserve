/**
 * Enforcement tests — deny-by-default SQL policies
 *
 * Verifies that after applyDenyByDefault:
 * 1. PUBLIC access to the app schema is revoked
 * 2. The app's own role can create tables in its schema
 * 3. Another role cannot access the app's schema (cross-app denial)
 * 4. search_path is fixed at role level
 * 5. Running applyDenyByDefault twice does not error (idempotent)
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionAppSchema } from '../../src/isolation/provision.js';
import { applyDenyByDefault } from '../../src/isolation/enforcement.js';

const pgPort = 15553;
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

test('enforcement - applyDenyByDefault does not throw', async () => {
  await provisionAppSchema(sql, 'enforce-app', { enforceDenyByDefault: false });
  await expect(applyDenyByDefault(sql, 'enforce-app')).resolves.toBeUndefined();
});

test('enforcement - is idempotent (running twice does not error)', async () => {
  await provisionAppSchema(sql, 'idempotent-enforce', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'idempotent-enforce');
  // Second call must not throw
  await expect(applyDenyByDefault(sql, 'idempotent-enforce')).resolves.toBeUndefined();
});

test('enforcement - app role has USAGE on its own schema', async () => {
  await provisionAppSchema(sql, 'grant-test', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'grant-test');

  // pg_namespace_acl for this schema should grant USAGE to the role
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_grant_test_role', 'app_grant_test', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('enforcement - app role has CREATE on its own schema', async () => {
  await provisionAppSchema(sql, 'create-test', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'create-test');

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_create_test_role', 'app_create_test', 'CREATE') AS has_create
  `);
  expect(rows[0].has_create).toBe(true);
});

test('enforcement - PUBLIC does not have CREATE on app schema', async () => {
  await provisionAppSchema(sql, 'public-deny-test', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'public-deny-test');

  // Create a test role that has no explicit grants — represents arbitrary non-app user
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_outsider_role') THEN
        CREATE ROLE test_outsider_role NOLOGIN;
      END IF;
    END
    $$
  `);

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('test_outsider_role', 'app_public_deny_test', 'CREATE') AS has_create
  `);
  expect(rows[0].has_create).toBe(false);
});

test('enforcement - PUBLIC does not have USAGE on app schema', async () => {
  await provisionAppSchema(sql, 'usage-deny-test', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'usage-deny-test');

  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_outsider_role') THEN
        CREATE ROLE test_outsider_role NOLOGIN;
      END IF;
    END
    $$
  `);

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('test_outsider_role', 'app_usage_deny_test', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});

test('enforcement - role search_path is set at role level', async () => {
  await provisionAppSchema(sql, 'searchpath-test', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'searchpath-test');

  // pg_roles.rolconfig should contain search_path setting
  const rows = await sql.unsafe(`
    SELECT rolconfig FROM pg_roles WHERE rolname = 'app_searchpath_test_role'
  `);
  expect(rows.length).toBe(1);
  const config = rows[0].rolconfig;
  // rolconfig is an array of "key=value" strings, or null if none
  const searchPathEntry = config && config.find(c => c.startsWith('search_path='));
  expect(searchPathEntry).toBeDefined();
  expect(searchPathEntry).toContain('app_searchpath_test');
});

test('enforcement - cross-app denial: another role cannot access schema', async () => {
  // Provision two separate apps
  await provisionAppSchema(sql, 'app-alpha', { enforceDenyByDefault: false });
  await provisionAppSchema(sql, 'app-beta', { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, 'app-alpha');
  await applyDenyByDefault(sql, 'app-beta');

  // app_app_beta_role should NOT have USAGE on app_app_alpha schema
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('app_app_beta_role', 'app_app_alpha', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});
