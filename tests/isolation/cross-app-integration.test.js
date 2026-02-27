/**
 * Cross-App Isolation Integration Test
 *
 * This is the "gate" test that proves the core security guarantee:
 * App A CANNOT access App B's data.
 *
 * Test scenario:
 * 1. Provision two apps: "xapp-alpha" and "xapp-beta"
 * 2. Enforcement applied (deny-by-default) on both
 * 3. As app_xapp_alpha_role: CREATE TABLE in own schema, INSERT data — works
 * 4. As app_xapp_alpha_role: attempt to read from xapp-beta schema — permission denied
 * 5. As app_xapp_beta_role: attempt to read from xapp-alpha schema — permission denied
 * 6. As app_xapp_alpha_role: attempt to CREATE TABLE in xapp-beta schema — permission denied
 * 7. As postgres (admin): verify both schemas have correct isolated data
 * 8. Validate connection info matches catalog
 * 9. Validate admin role is rejected for app connections
 *
 * Implementation note: role impersonation is done via SET ROLE within the
 * admin connection, which avoids needing separate LOGIN roles and keeps
 * setup simple while still proving real SQL-level permission enforcement.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import {
  initCatalog,
  provisionAppSchema,
  getAppConnectionInfo,
  validateAppConnection,
} from '../../src/isolation/index.js';

const pgPort = 15556;

let pgManager;
/** @type {import('bun').SQL} Admin connection */
let sql;

// App IDs used in this test suite
const ALPHA_APP_ID = 'xapp-alpha';
const BETA_APP_ID = 'xapp-beta';

// Derived names (match normalizeAppId logic: lowercase + hyphens->underscores)
const ALPHA_SCHEMA = 'app_xapp_alpha';
const ALPHA_ROLE = 'app_xapp_alpha_role';

const BETA_SCHEMA = 'app_xapp_beta';
const BETA_ROLE = 'app_xapp_beta_role';

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

  // Step 1 & 2: Provision both apps with deny-by-default enforcement
  await initCatalog(sql);
  await provisionAppSchema(sql, ALPHA_APP_ID, { enforceDenyByDefault: true });
  await provisionAppSchema(sql, BETA_APP_ID, { enforceDenyByDefault: true });
}, 90000);

afterAll(async () => {
  if (sql) {
    // Clean up test data
    await sql.unsafe(`DROP TABLE IF EXISTS "${ALPHA_SCHEMA}".items`).catch(() => {});
    await sql.unsafe(`DROP TABLE IF EXISTS "${BETA_SCHEMA}".items`).catch(() => {});
    await sql.close().catch(() => {});
  }
  if (pgManager) await pgManager.stop();
}, 30000);

// ─── Helper: run a query as a given role ─────────────────────────────────────

/**
 * Execute a callback as a specific PostgreSQL role using SET ROLE / RESET ROLE.
 * The superuser can SET ROLE to any role. This simulates what an app connection
 * would do when its login role inherits from the app role.
 *
 * @param {string} roleName - Role to impersonate
 * @param {() => Promise<any>} fn - Async callback executed under that role
 */
async function asRole(roleName, fn) {
  await sql.unsafe(`SET ROLE "${roleName}"`);
  try {
    return await fn();
  } finally {
    await sql.unsafe(`RESET ROLE`);
  }
}

// ─── Step 3: App alpha can CRUD in its own schema ────────────────────────────

test('cross-app - app_alpha can CREATE TABLE in own schema', async () => {
  await asRole(ALPHA_ROLE, async () => {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${ALPHA_SCHEMA}".items (id SERIAL PRIMARY KEY, payload TEXT)`,
    );
  });

  // Verify the table exists (as admin)
  const tables = await sql.unsafe(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = '${ALPHA_SCHEMA}' AND table_name = 'items'
  `);
  expect(tables.length).toBe(1);
});

test('cross-app - app_alpha can INSERT into own schema', async () => {
  await asRole(ALPHA_ROLE, async () => {
    await sql.unsafe(`INSERT INTO "${ALPHA_SCHEMA}".items (payload) VALUES ('alpha-secret')`);
  });

  const rows = await sql.unsafe(`SELECT payload FROM "${ALPHA_SCHEMA}".items`);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].payload).toBe('alpha-secret');
});

test('cross-app - app_alpha can SELECT from own schema', async () => {
  let rows;
  await asRole(ALPHA_ROLE, async () => {
    rows = await sql.unsafe(`SELECT payload FROM "${ALPHA_SCHEMA}".items`);
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].payload).toBe('alpha-secret');
});

// ─── Step 4: App alpha CANNOT read from app beta ─────────────────────────────

test('cross-app - app_alpha CANNOT SELECT from app_beta schema (permission denied)', async () => {
  // Ensure beta schema has a table (created as admin) so the error is about permissions
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS "${BETA_SCHEMA}".items (id SERIAL PRIMARY KEY, payload TEXT)`,
  );
  await sql.unsafe(
    `INSERT INTO "${BETA_SCHEMA}".items (payload) VALUES ('beta-secret') ON CONFLICT DO NOTHING`,
  );

  let errorCaught = false;
  try {
    await asRole(ALPHA_ROLE, async () => {
      await sql.unsafe(`SELECT payload FROM "${BETA_SCHEMA}".items`);
    });
  } catch (err) {
    errorCaught = true;
    expect(err.message.toLowerCase()).toContain('permission denied');
  }
  expect(errorCaught).toBe(true);
});

// ─── Step 5: App beta CANNOT read from app alpha ─────────────────────────────

test('cross-app - app_beta CANNOT SELECT from app_alpha schema (permission denied)', async () => {
  let errorCaught = false;
  try {
    await asRole(BETA_ROLE, async () => {
      await sql.unsafe(`SELECT payload FROM "${ALPHA_SCHEMA}".items`);
    });
  } catch (err) {
    errorCaught = true;
    expect(err.message.toLowerCase()).toContain('permission denied');
  }
  expect(errorCaught).toBe(true);
});

// ─── Step 6: App alpha CANNOT create tables in app beta schema ────────────────

test('cross-app - app_alpha CANNOT CREATE TABLE in app_beta schema (permission denied)', async () => {
  let errorCaught = false;
  try {
    await asRole(ALPHA_ROLE, async () => {
      await sql.unsafe(`CREATE TABLE "${BETA_SCHEMA}".alpha_intrusion (id SERIAL)`);
    });
  } catch (err) {
    errorCaught = true;
    expect(err.message.toLowerCase()).toContain('permission denied');
  }
  expect(errorCaught).toBe(true);
});

// ─── Step 7: Admin verifies both schemas have correct isolated data ───────────

test('cross-app - admin verifies alpha schema data is isolated', async () => {
  const rows = await sql.unsafe(`SELECT payload FROM "${ALPHA_SCHEMA}".items`);
  expect(rows.length).toBeGreaterThan(0);
  const payloads = rows.map((r) => r.payload);
  expect(payloads).toContain('alpha-secret');
  // Alpha schema must NOT contain beta data
  expect(payloads).not.toContain('beta-secret');
});

test('cross-app - admin verifies beta schema data is isolated', async () => {
  const rows = await sql.unsafe(`SELECT payload FROM "${BETA_SCHEMA}".items`);
  expect(rows.length).toBeGreaterThan(0);
  const payloads = rows.map((r) => r.payload);
  expect(payloads).toContain('beta-secret');
  // Beta schema must NOT contain alpha data
  expect(payloads).not.toContain('alpha-secret');
});

// ─── Step 8: Connection info matches catalog ──────────────────────────────────

test('cross-app - alpha connection info matches catalog', async () => {
  const info = await getAppConnectionInfo(sql, ALPHA_APP_ID);
  expect(info).not.toBeNull();
  expect(info.schemaName).toBe(ALPHA_SCHEMA);
  expect(info.roleName).toBe(ALPHA_ROLE);
  expect(info.searchPath).toContain(ALPHA_SCHEMA);
  expect(info.connectionOptions.searchPath).toBe(info.searchPath);
});

test('cross-app - beta connection info matches catalog', async () => {
  const info = await getAppConnectionInfo(sql, BETA_APP_ID);
  expect(info).not.toBeNull();
  expect(info.schemaName).toBe(BETA_SCHEMA);
  expect(info.roleName).toBe(BETA_ROLE);
  expect(info.searchPath).toContain(BETA_SCHEMA);
  expect(info.connectionOptions.searchPath).toBe(info.searchPath);
});

// ─── Step 9: Admin role is rejected for app connections ───────────────────────

test('cross-app - admin role (postgres) is rejected for alpha app connection', async () => {
  const result = await validateAppConnection(sql, ALPHA_APP_ID, 'postgres');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
});

test('cross-app - admin role (postgres) is rejected for beta app connection', async () => {
  const result = await validateAppConnection(sql, BETA_APP_ID, 'postgres');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

// ─── Bonus: wrong role validation ────────────────────────────────────────────

test('cross-app - alpha role fails validation for beta app', async () => {
  // Alpha's role is rejected when used against beta's appId
  const result = await validateAppConnection(sql, BETA_APP_ID, ALPHA_ROLE);
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

test('cross-app - beta role fails validation for alpha app', async () => {
  const result = await validateAppConnection(sql, ALPHA_APP_ID, BETA_ROLE);
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

// ─── Privilege-level checks (belt and suspenders) ────────────────────────────

test('cross-app - alpha role has no SELECT privilege on beta items table', async () => {
  const rows = await sql.unsafe(`
    SELECT has_table_privilege('${ALPHA_ROLE}', '${BETA_SCHEMA}.items', 'SELECT') AS can_select
  `);
  expect(rows[0].can_select).toBe(false);
});

test('cross-app - beta role has no SELECT privilege on alpha items table', async () => {
  const rows = await sql.unsafe(`
    SELECT has_table_privilege('${BETA_ROLE}', '${ALPHA_SCHEMA}.items', 'SELECT') AS can_select
  `);
  expect(rows[0].can_select).toBe(false);
});

test('cross-app - alpha role has no CREATE privilege on beta schema', async () => {
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('${ALPHA_ROLE}', '${BETA_SCHEMA}', 'CREATE') AS can_create
  `);
  expect(rows[0].can_create).toBe(false);
});

test('cross-app - beta role has no USAGE privilege on alpha schema', async () => {
  const rows = await sql.unsafe(`
    SELECT has_schema_privilege('${BETA_ROLE}', '${ALPHA_SCHEMA}', 'USAGE') AS has_usage
  `);
  expect(rows[0].has_usage).toBe(false);
});
