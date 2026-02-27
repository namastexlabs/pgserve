/**
 * Admin hardening tests — validateConnection + isAdminRole
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresManager } from '../../src/postgres.js';
import { createLogger } from '../../src/logger.js';
import { initCatalog } from '../../src/isolation/catalog.js';
import { provisionSchema } from '../../src/isolation/provision.js';
import { validateConnection, isAdminRole } from '../../src/isolation/admin-hardening.js';

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
  await provisionSchema(sql, { name: 'hardening', schemaName: 'hardening_schema', roleName: 'hardening_role' }, { enforceDenyByDefault: false });
}, 60000);

afterAll(async () => {
  if (sql) await sql.close().catch(() => {});
  if (pgManager) await pgManager.stop();
}, 30000);

// ─── isAdminRole ──────────────────────────────────────────────────────────────

test('admin-hardening - isAdminRole returns true for postgres superuser', async () => {
  expect(await isAdminRole(sql, 'postgres')).toBe(true);
});

test('admin-hardening - isAdminRole returns false for regular role', async () => {
  expect(await isAdminRole(sql, 'hardening_role')).toBe(false);
});

test('admin-hardening - isAdminRole returns false for unknown role', async () => {
  expect(await isAdminRole(sql, 'totally_unknown_role_xyz')).toBe(false);
});

// ─── validateConnection ────────────────────────────────────────────────────

test('admin-hardening - correct role passes validation', async () => {
  const result = await validateConnection(sql, 'hardening', 'hardening_role');
  expect(result.valid).toBe(true);
  expect(result.reason).toBeUndefined();
});

test('admin-hardening - admin user postgres is rejected', async () => {
  const result = await validateConnection(sql, 'hardening', 'postgres');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
});

test('admin-hardening - wrong role is rejected', async () => {
  await provisionSchema(sql, { name: 'other', schemaName: 'other_schema', roleName: 'other_role' }, { enforceDenyByDefault: false });
  const result = await validateConnection(sql, 'hardening', 'other_role');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

test('admin-hardening - unprovisioned name returns invalid', async () => {
  const result = await validateConnection(sql, 'ghost', 'some_role');
  expect(result.valid).toBe(false);
  expect(typeof result.reason).toBe('string');
});

test('admin-hardening - rejects any superuser role', async () => {
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_superuser') THEN
        CREATE ROLE test_superuser SUPERUSER NOLOGIN;
      END IF;
    END $$
  `);

  const result = await validateConnection(sql, 'hardening', 'test_superuser');
  expect(result.valid).toBe(false);
  expect(result.reason).toBeDefined();
});
