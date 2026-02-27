/**
 * Admin hardening tests — validateAppConnection + isAdminRole
 *
 * Verifies:
 * 1. Admin user (postgres/superuser) is rejected for app connections
 * 2. Correct app role passes validation
 * 3. Wrong app role is rejected
 * 4. Superuser detection works via isAdminRole
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionAppSchema } from '../../src/isolation/provision.js';
import { validateAppConnection, isAdminRole } from '../../src/isolation/admin-hardening.js';

const pgPort = 15554;
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

  // Provision a test app
  await provisionAppSchema(sql, 'hardening-app', { enforceDenyByDefault: false });
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

// ─── isAdminRole ──────────────────────────────────────────────────────────────

test('admin-hardening - isAdminRole returns true for postgres superuser', async () => {
  const result = await isAdminRole(sql, 'postgres');
  expect(result).toBe(true);
});

test('admin-hardening - isAdminRole returns false for regular app role', async () => {
  const result = await isAdminRole(sql, 'app_hardening_app_role');
  expect(result).toBe(false);
});

test('admin-hardening - isAdminRole returns false for unknown role', async () => {
  const result = await isAdminRole(sql, 'totally_unknown_role_xyz');
  expect(result).toBe(false);
});

// ─── validateAppConnection ────────────────────────────────────────────────────

test('admin-hardening - correct app role passes validation', async () => {
  const result = await validateAppConnection(sql, 'hardening-app', 'app_hardening_app_role');
  expect(result.valid).toBe(true);
  expect(result.reason).toBeUndefined();
});

test('admin-hardening - admin user postgres is rejected', async () => {
  const result = await validateAppConnection(sql, 'hardening-app', 'postgres');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
});

test('admin-hardening - wrong app role is rejected', async () => {
  // Provision another app
  await provisionAppSchema(sql, 'other-app', { enforceDenyByDefault: false });

  // Try to connect to hardening-app using other-app's role
  const result = await validateAppConnection(sql, 'hardening-app', 'app_other_app_role');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

test('admin-hardening - unprovisioned appId returns invalid', async () => {
  const result = await validateAppConnection(sql, 'ghost-app', 'some_role');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

test('admin-hardening - validateAppConnection rejects any superuser role', async () => {
  // Create a custom superuser to test beyond the hardcoded 'postgres' check
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_superuser') THEN
        CREATE ROLE test_superuser SUPERUSER NOLOGIN;
      END IF;
    END
    $$
  `);

  const result = await validateAppConnection(sql, 'hardening-app', 'test_superuser');
  expect(result.valid).toBe(false);
  expect(result.reason).toBeDefined();
});
