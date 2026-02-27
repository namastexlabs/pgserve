/**
 * Enforcement tests — deny-by-default SQL policies
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionSchema } from '../../src/isolation/provision.js';
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
  await provisionSchema(sql, { name: 'enforce', schemaName: 'enforce_schema', roleName: 'enforce_role' }, { enforceDenyByDefault: false });
  await expect(applyDenyByDefault(sql, { schemaName: 'enforce_schema', roleName: 'enforce_role' })).resolves.toBeUndefined();
});

test('enforcement - is idempotent (running twice does not error)', async () => {
  await provisionSchema(sql, { name: 'idempotent-e', schemaName: 'idempotent_e_schema', roleName: 'idempotent_e_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'idempotent_e_schema', roleName: 'idempotent_e_role' });
  await expect(applyDenyByDefault(sql, { schemaName: 'idempotent_e_schema', roleName: 'idempotent_e_role' })).resolves.toBeUndefined();
});

test('enforcement - role has USAGE on its own schema', async () => {
  await provisionSchema(sql, { name: 'grant-t', schemaName: 'grant_t_schema', roleName: 'grant_t_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'grant_t_schema', roleName: 'grant_t_role' });

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('grant_t_role', 'grant_t_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(true);
});

test('enforcement - role has CREATE on its own schema', async () => {
  await provisionSchema(sql, { name: 'create-t', schemaName: 'create_t_schema', roleName: 'create_t_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'create_t_schema', roleName: 'create_t_role' });

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('create_t_role', 'create_t_schema', 'CREATE') AS has_create
  `);
  expect(rows[0].has_create).toBe(true);
});

test('enforcement - PUBLIC does not have CREATE on schema', async () => {
  await provisionSchema(sql, { name: 'pub-deny', schemaName: 'pub_deny_schema', roleName: 'pub_deny_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'pub_deny_schema', roleName: 'pub_deny_role' });

  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_outsider_role') THEN
        CREATE ROLE test_outsider_role NOLOGIN;
      END IF;
    END $$
  `);

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('test_outsider_role', 'pub_deny_schema', 'CREATE') AS has_create
  `);
  expect(rows[0].has_create).toBe(false);
});

test('enforcement - PUBLIC does not have USAGE on schema', async () => {
  await provisionSchema(sql, { name: 'usage-deny', schemaName: 'usage_deny_schema', roleName: 'usage_deny_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'usage_deny_schema', roleName: 'usage_deny_role' });

  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_outsider_role') THEN
        CREATE ROLE test_outsider_role NOLOGIN;
      END IF;
    END $$
  `);

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('test_outsider_role', 'usage_deny_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});

test('enforcement - role search_path is set at role level', async () => {
  await provisionSchema(sql, { name: 'sp-test', schemaName: 'sp_test_schema', roleName: 'sp_test_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'sp_test_schema', roleName: 'sp_test_role' });

  const rows = await sql.unsafe(`
    SELECT rolconfig FROM pg_roles WHERE rolname = 'sp_test_role'
  `);
  expect(rows.length).toBe(1);
  const config = rows[0].rolconfig;
  const searchPathEntry = config && config.find(c => c.startsWith('search_path='));
  expect(searchPathEntry).toBeDefined();
  expect(searchPathEntry).toContain('sp_test_schema');
});

test('enforcement - cross denial: another role cannot access schema', async () => {
  await provisionSchema(sql, { name: 'alpha-e', schemaName: 'alpha_e_schema', roleName: 'alpha_e_role' }, { enforceDenyByDefault: false });
  await provisionSchema(sql, { name: 'beta-e', schemaName: 'beta_e_schema', roleName: 'beta_e_role' }, { enforceDenyByDefault: false });
  await applyDenyByDefault(sql, { schemaName: 'alpha_e_schema', roleName: 'alpha_e_role' });
  await applyDenyByDefault(sql, { schemaName: 'beta_e_schema', roleName: 'beta_e_role' });

  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('beta_e_role', 'alpha_e_schema', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});
