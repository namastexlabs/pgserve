/**
 * Tests for src/control-db.js — pgserve_meta schema + accessors.
 *
 * Boots an ephemeral pgserve router (memory mode), connects via node-pg
 * to the default `postgres` database, and exercises every exported function.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import pg from 'pg';
import { startMultiTenantServer } from '../src/index.js';
import {
  ensureMetaSchema,
  recordDbCreated,
  touchLastConnection,
  markPersist,
  forEachReapable,
  deleteMetaRow,
  addAllowedToken,
  revokeAllowedToken,
  verifyToken,
  findRowByFingerprint,
} from '../src/control-db.js';

const { Client } = pg;

const TEST_DATA_DIR = './test-data-control-db';
const PORT = 15561;

let router;
let client;

function cleanupDataDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  cleanupDataDir();
  router = await startMultiTenantServer({
    port: PORT,
    baseDir: TEST_DATA_DIR,
    logLevel: 'warn',
  });

  client = new Client({
    host: '127.0.0.1',
    port: PORT,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS pgserve_meta');
});

afterAll(async () => {
  try { await client.end(); } catch { /* noop */ }
  try { await router.stop(); } catch { /* noop */ }
  cleanupDataDir();
});

test('ensureMetaSchema creates table on first call', async () => {
  await ensureMetaSchema(client);
  const r = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pgserve_meta'
    ORDER BY ordinal_position
  `);
  const columns = r.rows.map(row => row.column_name);
  expect(columns).toEqual([
    'database_name',
    'fingerprint',
    'peer_uid',
    'package_realpath',
    'created_at',
    'last_connection_at',
    'liveness_pid',
    'persist',
    'allowed_tokens',
  ]);
});

test('ensureMetaSchema is idempotent', async () => {
  await ensureMetaSchema(client);
  await ensureMetaSchema(client);
  // No throw — schema unchanged.
  const r = await client.query(`SELECT count(*)::int AS n FROM pgserve_meta`);
  expect(r.rows[0].n).toBe(0);
});

test('recordDbCreated inserts a row + select round-trip', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_demo_abc123def456',
    fingerprint: 'abc123def456',
    peerUid: 1000,
    packageRealpath: '/home/me/proj/package.json',
    livenessPid: 4242,
    persist: false,
  });
  const r = await client.query(`SELECT * FROM pgserve_meta WHERE database_name = $1`, [
    'app_demo_abc123def456',
  ]);
  expect(r.rows.length).toBe(1);
  const row = r.rows[0];
  expect(row.fingerprint).toBe('abc123def456');
  expect(row.peer_uid).toBe(1000);
  expect(row.package_realpath).toBe('/home/me/proj/package.json');
  expect(row.liveness_pid).toBe(4242);
  expect(row.persist).toBe(false);
  expect(row.created_at).toBeInstanceOf(Date);
  expect(row.last_connection_at).toBeInstanceOf(Date);
});

test('recordDbCreated upserts on conflict (database_name PK)', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_demo_abc123def456',
    fingerprint: 'abc123def456',
    peerUid: 1000,
    packageRealpath: '/home/me/proj/package.json',
    livenessPid: 4242,
  });
  // Re-insert with new peerUid + livenessPid → must upsert.
  await recordDbCreated(client, {
    databaseName: 'app_demo_abc123def456',
    fingerprint: 'abc123def456',
    peerUid: 1001,
    packageRealpath: '/home/me/proj/package.json',
    livenessPid: 9999,
    persist: true,
  });
  const r = await client.query(`SELECT peer_uid, liveness_pid, persist FROM pgserve_meta`);
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].peer_uid).toBe(1001);
  expect(r.rows[0].liveness_pid).toBe(9999);
  expect(r.rows[0].persist).toBe(true);
});

test('touchLastConnection bumps last_connection_at and liveness_pid', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_x_111111111111',
    fingerprint: '111111111111',
    peerUid: 1000,
    livenessPid: 100,
  });
  const before = await client.query(
    `SELECT last_connection_at, liveness_pid FROM pgserve_meta WHERE database_name = $1`,
    ['app_x_111111111111'],
  );
  // Sleep briefly so now() advances visibly.
  await new Promise(r => setTimeout(r, 50));

  await touchLastConnection(client, {
    databaseName: 'app_x_111111111111',
    livenessPid: 200,
  });
  const after = await client.query(
    `SELECT last_connection_at, liveness_pid FROM pgserve_meta WHERE database_name = $1`,
    ['app_x_111111111111'],
  );
  expect(after.rows[0].liveness_pid).toBe(200);
  expect(after.rows[0].last_connection_at.getTime()).toBeGreaterThan(
    before.rows[0].last_connection_at.getTime(),
  );
});

test('markPersist toggles persist flag', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_p_222222222222',
    fingerprint: '222222222222',
    peerUid: 1000,
  });
  await markPersist(client, 'app_p_222222222222', true);
  let r = await client.query(`SELECT persist FROM pgserve_meta WHERE database_name = $1`, [
    'app_p_222222222222',
  ]);
  expect(r.rows[0].persist).toBe(true);

  await markPersist(client, 'app_p_222222222222', false);
  r = await client.query(`SELECT persist FROM pgserve_meta WHERE database_name = $1`, [
    'app_p_222222222222',
  ]);
  expect(r.rows[0].persist).toBe(false);
});

test('forEachReapable yields only persist=false rows in last_connection_at order', async () => {
  await client.query('TRUNCATE pgserve_meta');
  // Older row first, newer row second; persistent row separately.
  await client.query(
    `INSERT INTO pgserve_meta (database_name, fingerprint, peer_uid, last_connection_at, persist)
     VALUES
       ('app_a_aaaaaaaaaaaa', 'aaaaaaaaaaaa', 1000, now() - interval '2 hours', false),
       ('app_b_bbbbbbbbbbbb', 'bbbbbbbbbbbb', 1000, now() - interval '1 hour',  false),
       ('app_c_cccccccccccc', 'cccccccccccc', 1000, now(),                       true)`,
  );

  const seen = [];
  for await (const row of forEachReapable(client, { now: new Date() })) {
    seen.push(row.databaseName);
  }
  expect(seen).toEqual(['app_a_aaaaaaaaaaaa', 'app_b_bbbbbbbbbbbb']);
});

test('deleteMetaRow removes the row', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_del_333333333333',
    fingerprint: '333333333333',
    peerUid: 1000,
  });
  await deleteMetaRow(client, 'app_del_333333333333');
  const r = await client.query(`SELECT count(*)::int AS n FROM pgserve_meta`);
  expect(r.rows[0].n).toBe(0);
});

test('recordDbCreated rejects bad input', async () => {
  await expect(recordDbCreated(client, { fingerprint: 'x', peerUid: 1 })).rejects.toThrow(
    /databaseName required/,
  );
  await expect(recordDbCreated(client, { databaseName: 'd', peerUid: 1 })).rejects.toThrow(
    /fingerprint required/,
  );
  await expect(
    recordDbCreated(client, { databaseName: 'd', fingerprint: 'f', peerUid: 'nope' }),
  ).rejects.toThrow(/peerUid must be number/);
});

test('addAllowedToken refuses unknown fingerprint', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await expect(
    addAllowedToken(client, { fingerprint: 'deadbeef0000', tokenId: 'tk1', tokenHash: 'h1' }),
  ).rejects.toThrow(/no pgserve_meta row/);
});

test('addAllowedToken appends, verifyToken finds it, revokeAllowedToken removes it', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_demo_4444aabbccdd',
    fingerprint: '4444aabbccdd',
    peerUid: 1000,
  });
  await addAllowedToken(client, {
    fingerprint: '4444aabbccdd',
    tokenId: 'aaaa1111',
    tokenHash: 'hash-1',
  });
  await addAllowedToken(client, {
    fingerprint: '4444aabbccdd',
    tokenId: 'bbbb2222',
    tokenHash: 'hash-2',
  });

  const row = await findRowByFingerprint(client, '4444aabbccdd');
  expect(row).not.toBeNull();
  expect(row.allowedTokens.length).toBe(2);
  expect(row.allowedTokens.map(t => t.id).sort()).toEqual(['aaaa1111', 'bbbb2222']);

  const ok = await verifyToken(client, { fingerprint: '4444aabbccdd', tokenHash: 'hash-2' });
  expect(ok).toEqual({ tokenId: 'bbbb2222', databaseName: 'app_demo_4444aabbccdd' });

  const miss = await verifyToken(client, { fingerprint: '4444aabbccdd', tokenHash: 'no-such' });
  expect(miss).toBeNull();

  const affected = await revokeAllowedToken(client, 'aaaa1111');
  expect(affected).toBe(1);

  const after = await findRowByFingerprint(client, '4444aabbccdd');
  expect(after.allowedTokens.map(t => t.id)).toEqual(['bbbb2222']);
});

test('revokeAllowedToken returns 0 for unknown id', async () => {
  await client.query('TRUNCATE pgserve_meta');
  await recordDbCreated(client, {
    databaseName: 'app_x_5555aabbccdd',
    fingerprint: '5555aabbccdd',
    peerUid: 1000,
  });
  const affected = await revokeAllowedToken(client, 'nonexistent');
  expect(affected).toBe(0);
});
