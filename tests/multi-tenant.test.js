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
import { test } from 'node:test';
import assert from 'node:assert';
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

test('Multi-tenant router - basic setup', async (t) => {
  cleanup();

  const router = await startMultiTenantServer({
    port: 15432, // Use non-standard port for testing
    baseDir: testDataDir,
    logLevel: 'info'
  });

  // Verify router started
  const stats = router.getStats();
  assert.equal(stats.port, 15432);
  assert.equal(stats.pool.totalInstances, 0); // No instances yet

  await router.stop();
  cleanup();
});

test('Multi-tenant router - auto-provision database', async (t) => {
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
    user: 'postgres' // PGlite doesn't require auth
  });

  await client.connect();

  // Verify instance was created
  const stats = router.getStats();
  assert.equal(stats.pool.totalInstances, 1);

  const databases = router.listDatabases();
  assert.equal(databases.length, 1);
  assert.equal(databases[0].dbName, 'testdb1');
  assert.equal(databases[0].locked, true); // Locked to connection

  // Create table
  await client.query('CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)');
  await client.query("INSERT INTO users (name) VALUES ('Alice')");

  // Query
  const result = await client.query('SELECT * FROM users');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, 'Alice');

  await client.end();
  await router.stop();
  cleanup();
});

test('Multi-tenant router - multiple databases isolated', async (t) => {
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
    database: 'db1'
  });

  await client1.connect();
  await client1.query('CREATE TABLE users (id INT, name TEXT)');
  await client1.query("INSERT INTO users VALUES (1, 'Alice')");

  // Verify db1 exists
  let stats = router.getStats();
  assert.equal(stats.pool.totalInstances, 1);

  await client1.end();

  // Connect to database 2
  const client2 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'db2'
  });

  await client2.connect();
  await client2.query('CREATE TABLE posts (id INT, title TEXT)');
  await client2.query("INSERT INTO posts VALUES (1, 'Hello World')");

  // Verify db2 exists
  stats = router.getStats();
  assert.equal(stats.pool.totalInstances, 2);

  await client2.end();

  // Reconnect to db1 - verify data is isolated
  const client1Again = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'db1'
  });

  await client1Again.connect();

  // Should have users table, NOT posts table
  const usersResult = await client1Again.query('SELECT * FROM users');
  assert.equal(usersResult.rows.length, 1);
  assert.equal(usersResult.rows[0].name, 'Alice');

  // Posts table should NOT exist
  try {
    await client1Again.query('SELECT * FROM posts');
    assert.fail('Should throw error - posts table does not exist in db1');
  } catch (error) {
    assert.ok(error.message.includes('does not exist'));
  }

  await client1Again.end();
  await router.stop();
  cleanup();
});

test('Multi-tenant router - instance reuse', async (t) => {
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
    database: 'reuse-test'
  });

  await client1.connect();
  await client1.query('CREATE TABLE test (value INT)');
  await client1.query('INSERT INTO test VALUES (42)');
  await client1.end();

  // Second connection to same database (should reuse instance)
  const client2 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'reuse-test'
  });

  await client2.connect();

  // Should still have the table from client1
  const result = await client2.query('SELECT * FROM test');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].value, 42);

  // Still only 1 instance
  const stats = router.getStats();
  assert.equal(stats.pool.totalInstances, 1);

  await client2.end();
  await router.stop();
  cleanup();
});
