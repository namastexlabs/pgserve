/**
 * Multi-Tenant Router Test
 *
 * Tests the new multi-tenant architecture:
 * - Single port server
 * - Multiple databases auto-provisioned
 * - Database isolation
 */

import { startMultiTenantServer } from '../src/index.js';
import pg from 'pg';
import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

const { Client } = pg;

// Test data directory
const testDataDir = './test-data-multitenant';

// Cleanup helper
function cleanup() {
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

test('Multi-tenant router - basic setup', async () => {
  cleanup();

  const router = await startMultiTenantServer({
    port: 15432, // Use non-standard port for testing
    baseDir: testDataDir,
    logLevel: 'info'
  });

  // Verify router started
  const stats = router.getStats();
  expect(stats.port).toBe(15432);
  expect(stats.postgres.databases.length).toBe(0); // No databases yet

  await router.stop();
  cleanup();
});

test('Multi-tenant router - auto-provision database', async () => {
  cleanup();

  const router = await startMultiTenantServer({
    port: 15432,
    baseDir: testDataDir,
    logLevel: 'info'
  });

  // Connect to database "testdb1" (should auto-create)
  const client = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'testdb1',
    user: 'postgres',
    password: 'postgres'
  });

  await client.connect();

  // Verify instance was created
  const stats = router.getStats();
  expect(stats.postgres.databases.length).toBe(1);

  const databases = router.listDatabases();
  expect(databases.length).toBe(1);
  expect(databases[0]).toBe('testdb1');

  // Create table
  await client.query('CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)');
  await client.query("INSERT INTO users (name) VALUES ('Alice')");

  // Query
  const result = await client.query('SELECT * FROM users');
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].name).toBe('Alice');

  await client.end();
  await router.stop();
  cleanup();
});

test('Multi-tenant router - multiple databases isolated', async () => {
  cleanup();

  const router = await startMultiTenantServer({
    port: 15432,
    baseDir: testDataDir,
    logLevel: 'info'
  });

  // Connect to database 1
  const client1 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'db1',
    user: 'postgres',
    password: 'postgres'
  });

  await client1.connect();
  await client1.query('CREATE TABLE users (id INT, name TEXT)');
  await client1.query("INSERT INTO users VALUES (1, 'Alice')");

  // Verify db1 exists
  let stats = router.getStats();
  expect(stats.postgres.databases.length).toBe(1);

  await client1.end();

  // Connect to database 2
  const client2 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'db2',
    user: 'postgres',
    password: 'postgres'
  });

  await client2.connect();
  await client2.query('CREATE TABLE posts (id INT, title TEXT)');
  await client2.query("INSERT INTO posts VALUES (1, 'Hello World')");

  // Verify db2 exists
  stats = router.getStats();
  expect(stats.postgres.databases.length).toBe(2);

  await client2.end();

  // Reconnect to db1 - verify data is isolated
  const client1Again = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'db1',
    user: 'postgres',
    password: 'postgres'
  });

  await client1Again.connect();

  // Should have users table, NOT posts table
  const usersResult = await client1Again.query('SELECT * FROM users');
  expect(usersResult.rows.length).toBe(1);
  expect(usersResult.rows[0].name).toBe('Alice');

  // Posts table should NOT exist
  try {
    await client1Again.query('SELECT * FROM posts');
    throw new Error('Should throw error - posts table does not exist in db1');
  } catch (error) {
    expect(error.message).toContain('does not exist');
  }

  await client1Again.end();
  await router.stop();
  cleanup();
});

test('Router - pre-handshake buffer is bounded (issue #18 root cause #2)', async () => {
  // Regression test for issue #18: without a bound on state.buffer, a
  // client that sends garbage and never completes the PG startup would
  // grow router memory unbounded (traced to the production 74 GiB VmSize).
  // After fix, the router must close the connection once the buffer
  // exceeds MAX_STARTUP_BUFFER_SIZE (1 MiB).
  cleanup();

  const router = await startMultiTenantServer({
    port: 15546,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  const net = await import('net');
  const sock = net.connect(15546, '127.0.0.1');
  await new Promise((resolve) => sock.once('connect', resolve));

  const garbage = Buffer.alloc(256 * 1024, 0x41); // 256 KiB of 'A'
  let closed = false;
  sock.on('close', () => { closed = true; });

  // Send 5 × 256 KiB = 1.25 MiB, exceeding the 1 MiB cap.
  for (let i = 0; i < 5 && !closed; i++) {
    await new Promise((resolve) => sock.write(garbage, resolve));
  }

  // Wait up to 2s for the proxy to close the connection.
  const deadline = Date.now() + 2000;
  while (!closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(closed).toBe(true);
  sock.destroy();

  await router.stop();
  cleanup();
});

test('Router - socket state has startupInProgress flag (issue #18 root cause #1)', async () => {
  // White-box regression test for the reentrancy guard. Without
  // state.startupInProgress, two data events arriving during the first
  // processStartupMessage() await would launch concurrent async tasks
  // that race to assign state.pgSocket, leaking the loser. This test
  // verifies the flag is wired into the state object.
  cleanup();

  const router = await startMultiTenantServer({
    port: 15547,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  const net = await import('net');
  const sock = net.connect(15547, '127.0.0.1');
  await new Promise((resolve) => sock.once('connect', resolve));

  // Router tracks client sockets in this.connections; introspect to pull
  // the state object and confirm the flag exists and defaults to false.
  // On some platforms (macOS in particular) the client-side 'connect'
  // event fires slightly before the server-side handleSocketOpen runs,
  // so poll until the router has registered the connection rather than
  // asserting synchronously.
  const deadline = Date.now() + 2000;
  while (router.connections.size === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(router.connections.size).toBeGreaterThan(0);
  const bunSocket = [...router.connections][0];
  const state = router.socketState.get(bunSocket);
  expect(state).toBeDefined();
  expect(state.startupInProgress).toBe(false);

  sock.destroy();
  await router.stop();
  cleanup();
});

test('PostgresManager - stop() nulls socketDir/databaseDir (issue #24)', async () => {
  // Regression test for issue #24: router used to cache stale socketPath
  // pointing to a directory that stop() had already rmSync'd. After fix,
  // stop() nulls socketDir/databaseDir UNCONDITIONALLY so subsequent
  // getSocketPath() returns null (forcing TCP fallback in the router).
  cleanup();

  const { PostgresManager } = await import('../src/postgres.js');
  const { createLogger } = await import('../src/logger.js');
  const pg = new PostgresManager({
    port: 15543,
    logger: createLogger({ level: 'warn' }),
  });

  await pg.start();
  const socketPathBeforeStop = pg.getSocketPath();
  expect(socketPathBeforeStop).not.toBeNull();
  expect(fs.existsSync(pg.socketDir)).toBe(true);

  await pg.stop();

  // CORE ASSERTION: socketDir must be nulled after stop
  expect(pg.socketDir).toBeNull();
  expect(pg.getSocketPath()).toBeNull();
  // databaseDir nulled only in memory mode (persistent mode keeps user-owned path)
  expect(pg.databaseDir).toBeNull();
  // And the dir on disk must actually be gone
  // (socketPathBeforeStop points inside the deleted socketDir)
  const staleSocketDir = path.dirname(socketPathBeforeStop);
  expect(fs.existsSync(staleSocketDir)).toBe(false);
});

test('PostgresManager - start()+stop()+start() yields fresh socketDir (issue #24)', async () => {
  // Regression test for issue #24: pgManager.start() called after stop()
  // must produce a FRESH socketDir (different path). Without the fix, a
  // re-entry guard was missing and socketDir could leak across restarts.
  cleanup();

  const { PostgresManager } = await import('../src/postgres.js');
  const { createLogger } = await import('../src/logger.js');
  const pg = new PostgresManager({
    port: 15544,
    logger: createLogger({ level: 'warn' }),
  });

  await pg.start();
  const socketDir1 = pg.socketDir;
  expect(socketDir1).not.toBeNull();

  await pg.stop();
  expect(pg.socketDir).toBeNull();

  await pg.start();
  const socketDir2 = pg.socketDir;
  expect(socketDir2).not.toBeNull();
  expect(socketDir2).not.toBe(socketDir1);
  expect(fs.existsSync(socketDir2)).toBe(true);

  await pg.stop();
});

test('PostgresManager - double start() is a no-op (issue #24 re-entry guard)', async () => {
  // Without the guard, a second start() would overwrite socketDir/databaseDir
  // and leak the previous tmp dir (the "1,457 stale sock dirs" symptom).
  cleanup();

  const { PostgresManager } = await import('../src/postgres.js');
  const { createLogger } = await import('../src/logger.js');
  const pg = new PostgresManager({
    port: 15545,
    logger: createLogger({ level: 'warn' }),
  });

  await pg.start();
  const socketDir1 = pg.socketDir;

  // Second start() should silently return the same instance without
  // reassigning socketDir/databaseDir.
  const result = await pg.start();
  expect(result).toBe(pg);
  expect(pg.socketDir).toBe(socketDir1);

  await pg.stop();
});

test('Multi-tenant router - instance reuse', async () => {
  cleanup();

  const router = await startMultiTenantServer({
    port: 15432,
    baseDir: testDataDir,
    logLevel: 'info'
  });

  // First connection to "reuse-test"
  const client1 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'reuse-test',
    user: 'postgres',
    password: 'postgres'
  });

  await client1.connect();
  await client1.query('CREATE TABLE test (value INT)');
  await client1.query('INSERT INTO test VALUES (42)');
  await client1.end();

  // Second connection to same database (should reuse instance)
  const client2 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'reuse-test',
    user: 'postgres',
    password: 'postgres'
  });

  await client2.connect();

  // Should still have the table from client1
  const result = await client2.query('SELECT * FROM test');
  expect(result.rows.length).toBe(1);
  expect(result.rows[0].value).toBe(42);

  // Still only 1 database
  const stats = router.getStats();
  expect(stats.postgres.databases.length).toBe(1);

  await client2.end();
  await router.stop();
  cleanup();
});
