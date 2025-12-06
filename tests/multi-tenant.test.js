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
