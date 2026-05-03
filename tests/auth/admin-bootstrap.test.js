/**
 * Tests for src/auth/admin-bootstrap.js — Group 1, autopg-distribution-cutover.
 *
 * Boots a real PostgresManager with the bootstrap step skipped (so we get a
 * baseline `postgres:postgres` superuser instance), then drives bootstrapAdmin
 * directly with a temp secretPath. Each assertion targets one acceptance
 * criterion from the wish:
 *
 *   AC1: secret file mode is 0600 + admin.secret materializes
 *   AC2: re-running with existing secret + role does NOT rotate the secret
 *   AC3: autopg_admin role exists with LOGIN + SUPERUSER (psql -U autopg_admin succeeds)
 *   AC4: postgres role has no privileges (NOSUPERUSER NOCREATEDB NOCREATEROLE …)
 */

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQL } from 'bun';
import { PostgresManager } from '../../src/postgres.js';
import { configureAudit } from '../../src/audit.js';
import {
  bootstrapAdmin,
  generateAdminSecret,
  ADMIN_ROLE,
  _internals,
} from '../../src/auth/admin-bootstrap.js';

const TEST_DATA_DIR = path.resolve('./test-data-admin-bootstrap');
let scratchDir;
let pgManager;
let postgresPool;
let auditLogPath;

// Minimal logger shape — debug/info/warn match what postgres.js / audit.js consume.
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

beforeAll(async () => {
  // Skip the bootstrap inside PostgresManager.start() so we get a vanilla
  // postgres-superuser instance. We run bootstrapAdmin() ourselves below.
  process.env.AUTOPG_SKIP_ADMIN_BOOTSTRAP = '1';

  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  pgManager = new PostgresManager({
    dataDir: TEST_DATA_DIR,
    port: 0, // pick an available port
    logger: silentLogger,
  });
  await pgManager.start();

  postgresPool = new SQL({
    hostname: '127.0.0.1',
    port: pgManager.port,
    database: 'postgres',
    username: 'postgres',
    password: 'postgres',
    max: 2,
    idleTimeout: 5,
  });
  await postgresPool`SELECT 1`;
}, 60000);

afterAll(async () => {
  try { await postgresPool.close(); } catch { /* swallow */ }
  try { await pgManager.stop(); } catch { /* swallow */ }
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  delete process.env.AUTOPG_SKIP_ADMIN_BOOTSTRAP;
});

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-bootstrap-test-'));
  auditLogPath = path.join(scratchDir, 'audit.log');
  configureAudit({ logFile: auditLogPath, target: 'file' });
});

afterEach(async () => {
  // DROP role between cases so each test runs against a fresh slate. Some
  // tests assert the "create" path; we can't observe that twice without
  // tearing down between runs.
  try {
    await postgresPool.unsafe(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`);
  } catch { /* swallow */ }
  // Restore postgres role's privileges so other tests aren't affected.
  // (postgres is the bootstrap superuser; LOGIN/CREATEDB/etc. restore lets
  // us run the next test from a clean slate.)
  try {
    await postgresPool.unsafe('ALTER ROLE postgres WITH LOGIN CREATEDB CREATEROLE REPLICATION');
  } catch { /* swallow */ }
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('generateAdminSecret returns a 32-byte URL-safe token (~43 chars, no SQL specials)', () => {
  const tokens = new Set();
  for (let i = 0; i < 50; i++) tokens.add(generateAdminSecret());
  expect(tokens.size).toBe(50); // no collisions over 50 draws
  for (const t of tokens) {
    expect(t.length).toBeGreaterThanOrEqual(42);
    expect(t.length).toBeLessThanOrEqual(44);
    expect(/^[A-Za-z0-9_-]+$/.test(t)).toBe(true);
    expect(t.includes("'")).toBe(false);
  }
});

test('quoteLiteral doubles single quotes (defensive escape against custom secrets)', () => {
  expect(_internals.quoteLiteral('foo')).toBe("'foo'");
  expect(_internals.quoteLiteral("foo's")).toBe("'foo''s'");
  // Input has one apostrophe → output doubles it; outer quotes wrap.
  expect(_internals.quoteLiteral("'; DROP TABLE--")).toBe("'''; DROP TABLE--'");
});

test('first-run: creates secret file (mode 0600), creates autopg_admin role, revokes postgres privileges', async () => {
  const secretPath = path.join(scratchDir, 'admin.secret');
  expect(fs.existsSync(secretPath)).toBe(false);

  const result = await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });

  expect(result.status).toBe('created');
  expect(result.role).toBe(ADMIN_ROLE);
  expect(result.secretPath).toBe(secretPath);

  // AC1: secret file exists with mode 0600
  expect(fs.existsSync(secretPath)).toBe(true);
  const stat = fs.statSync(secretPath);
  expect(stat.mode & 0o777).toBe(0o600);
  const password = fs.readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
  expect(password.length).toBeGreaterThanOrEqual(42);

  // AC3: autopg_admin role exists with LOGIN + SUPERUSER
  const adminRows = await postgresPool`
    SELECT rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole
    FROM pg_authid WHERE rolname = ${ADMIN_ROLE}
  `;
  expect(adminRows.length).toBe(1);
  expect(adminRows[0].rolsuper).toBe(true);
  expect(adminRows[0].rolcanlogin).toBe(true);

  // AC4: postgres role can no longer authenticate (NOLOGIN — Sentinel B1
  // "either fails" branch). PG protects the bootstrap superuser from losing
  // SUPERUSER itself, so the privilege is unreachable via NOLOGIN, and
  // the other attributes are explicitly cleared.
  const pgRows = await postgresPool`
    SELECT rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_authid WHERE rolname = 'postgres'
  `;
  expect(pgRows.length).toBe(1);
  expect(pgRows[0].rolcanlogin).toBe(false);
  expect(pgRows[0].rolcreatedb).toBe(false);
  expect(pgRows[0].rolcreaterole).toBe(false);
  expect(pgRows[0].rolreplication).toBe(false);
  expect(pgRows[0].rolbypassrls).toBe(false);

  // Audit: created event was emitted
  const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
  const createdEvent = auditLines.map((l) => JSON.parse(l)).find((e) => e.event === 'admin_bootstrap_created');
  expect(createdEvent).toBeTruthy();
  expect(createdEvent.role).toBe(ADMIN_ROLE);
  expect(createdEvent.secret_path).toBe(secretPath);
});

test('idempotent re-run: secret file + role both exist → no rotation, idempotent-skip event', async () => {
  const secretPath = path.join(scratchDir, 'admin.secret');

  // First run: create both
  const first = await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });
  expect(first.status).toBe('created');
  const passwordBefore = fs.readFileSync(secretPath, 'utf8');
  const mtimeBefore = fs.statSync(secretPath).mtimeMs;

  // Second run (after a tick) — file + role both pre-exist
  await new Promise((r) => setTimeout(r, 10));
  const second = await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });
  expect(second.status).toBe('idempotent-skip');

  // Secret content unchanged (the AC: "Re-running ... does NOT rotate the admin secret")
  const passwordAfter = fs.readFileSync(secretPath, 'utf8');
  expect(passwordAfter).toBe(passwordBefore);

  // mtime should be unchanged — we never wrote
  const mtimeAfter = fs.statSync(secretPath).mtimeMs;
  expect(mtimeAfter).toBe(mtimeBefore);

  // Audit: idempotent-skip event
  const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
  const events = auditLines.map((l) => JSON.parse(l)).map((e) => e.event);
  expect(events).toContain('admin_bootstrap_created');
  expect(events).toContain('admin_bootstrap_idempotent_skip');
});

test('mode 0600 enforced even if the file pre-exists with broader perms', async () => {
  const secretPath = path.join(scratchDir, 'admin.secret');
  const password = generateAdminSecret();
  fs.writeFileSync(secretPath, `${password}\n`, { mode: 0o644 });
  expect(fs.statSync(secretPath).mode & 0o777).toBe(0o644);

  await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });

  expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
});

test('autopg_admin can authenticate via SCRAM with the password from admin.secret', async () => {
  const secretPath = path.join(scratchDir, 'admin.secret');
  await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });

  const password = fs.readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
  const adminPool = new SQL({
    hostname: '127.0.0.1',
    port: pgManager.port,
    database: 'postgres',
    username: ADMIN_ROLE,
    password,
    max: 1,
    idleTimeout: 2,
  });
  try {
    const r = await adminPool`SELECT current_user::text AS u`;
    expect(r[0].u).toBe(ADMIN_ROLE);
  } finally {
    await adminPool.close();
  }
});

test('parent dir is created with mode 0700 when missing', async () => {
  const nestedDir = path.join(scratchDir, 'deep', 'nested');
  const secretPath = path.join(nestedDir, 'admin.secret');
  expect(fs.existsSync(nestedDir)).toBe(false);

  await bootstrapAdmin(postgresPool, { secretPath, logger: silentLogger });
  expect(fs.existsSync(nestedDir)).toBe(true);
  // Parent dir mode (defensive — first parent of secretPath is `nested`)
  const stat = fs.statSync(nestedDir);
  expect(stat.mode & 0o700).toBe(0o700);
});
