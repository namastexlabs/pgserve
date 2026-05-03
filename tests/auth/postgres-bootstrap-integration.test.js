/**
 * Integration test for the PostgresManager → admin-bootstrap wiring.
 *
 * Asserts the wish's acceptance criteria end-to-end:
 *   AC1 — fresh-host install creates `<configDir>/admin.secret` with 0600
 *         and no `postgres:postgres` row reachable.
 *   AC2 — re-running start() on an existing host does NOT rotate the secret.
 *   AC3 — admin connection (autopg_admin + secret) works post-start.
 *   AC4 — `psql -h … -U postgres -d postgres` either fails or has no
 *         privileges (we assert: NOLOGIN — connection refused at auth).
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQL } from 'bun';
import { PostgresManager } from '../../src/postgres.js';
import { ADMIN_ROLE } from '../../src/auth/admin-bootstrap.js';

const TEST_DATA_DIR = path.resolve('./test-data-postgres-bootstrap-integration');
let configDir;
let pgManager;

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
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pg-int-'));
  process.env.AUTOPG_CONFIG_DIR = configDir;
  delete process.env.AUTOPG_SKIP_ADMIN_BOOTSTRAP;

  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  pgManager = new PostgresManager({
    dataDir: TEST_DATA_DIR,
    port: 0,
    logger: silentLogger,
  });
  await pgManager.start();
}, 90000);

afterAll(async () => {
  try { await pgManager.stop(); } catch { /* swallow */ }
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(configDir)) {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
  delete process.env.AUTOPG_CONFIG_DIR;
});

test('AC1: start() creates admin.secret at the configured config dir with mode 0600', () => {
  const secretPath = path.join(configDir, 'admin.secret');
  expect(fs.existsSync(secretPath)).toBe(true);
  const stat = fs.statSync(secretPath);
  expect(stat.mode & 0o777).toBe(0o600);
  const contents = fs.readFileSync(secretPath, 'utf8');
  expect(contents.trim().length).toBeGreaterThanOrEqual(42);
});

test('AC3: autopg_admin can authenticate via the on-disk secret', async () => {
  const secretPath = path.join(configDir, 'admin.secret');
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
    const r = await adminPool`SELECT current_user::text AS u, session_user::text AS s`;
    expect(r[0].u).toBe(ADMIN_ROLE);
    expect(r[0].s).toBe(ADMIN_ROLE);
  } finally {
    await adminPool.close();
  }
});

test('AC4: postgres role is NOLOGIN — `psql -U postgres` connection refused at auth', async () => {
  const rejectedPool = new SQL({
    hostname: '127.0.0.1',
    port: pgManager.port,
    database: 'postgres',
    username: 'postgres',
    password: 'postgres',
    max: 1,
    idleTimeout: 2,
    connectionTimeout: 2,
  });
  let connected = false;
  try {
    await rejectedPool`SELECT 1`;
    connected = true;
  } catch (err) {
    // Expected: SCRAM/auth failure or "role is not permitted to log in"
    const msg = String(err?.message || err);
    expect(/log\s*in|password|authentication|role/i.test(msg)).toBe(true);
  } finally {
    try { await rejectedPool.close(); } catch { /* swallow */ }
  }
  expect(connected).toBe(false);
});

test('pgManager.adminPool was pivoted to autopg_admin (current_user reflects pivot)', async () => {
  const r = await pgManager.adminPool`SELECT current_user::text AS u`;
  expect(r[0].u).toBe(ADMIN_ROLE);
  expect(pgManager.user).toBe(ADMIN_ROLE);
});

test('AC2: stop+start with same data dir does NOT rotate admin.secret', async () => {
  const secretPath = path.join(configDir, 'admin.secret');
  const before = fs.readFileSync(secretPath, 'utf8');
  const mtimeBefore = fs.statSync(secretPath).mtimeMs;

  await pgManager.stop();
  // Construct a fresh manager pointing at the same dir (simulates a host
  // restart). Allow some time for the prior postmaster to fully exit.
  await new Promise((r) => setTimeout(r, 500));
  pgManager = new PostgresManager({
    dataDir: TEST_DATA_DIR,
    port: 0,
    logger: silentLogger,
  });
  await pgManager.start();

  const after = fs.readFileSync(secretPath, 'utf8');
  expect(after).toBe(before);
  // mtime stays untouched on idempotent-skip — the bootstrap module never
  // re-writes when the file pre-exists.
  const mtimeAfter = fs.statSync(secretPath).mtimeMs;
  expect(mtimeAfter).toBe(mtimeBefore);
}, 90000);
