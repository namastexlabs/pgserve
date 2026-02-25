/**
 * Backpressure / Large Message Regression Tests
 *
 * Reproduces the deadlock from issue #14: TCP proxy drops bytes when
 * socket buffers are full, causing PostgreSQL to wait forever for the
 * remainder of a truncated wire protocol message.
 */

import { startMultiTenantServer } from '../src/index.js';
import pg from 'pg';
import { test, expect } from 'bun:test';
import fs from 'fs';

const { Client } = pg;

const TEST_PORT = 15433;
const testDataDir = './test-data-backpressure';

function cleanup() {
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

/** Create a connected pg.Client */
async function connect(dbName) {
  const client = new Client({
    host: '127.0.0.1',
    port: TEST_PORT,
    database: dbName,
    user: 'postgres',
    password: 'postgres',
  });
  await client.connect();
  return client;
}

test('Large INSERT (~360KB payload) does not deadlock', async () => {
  cleanup();
  const router = await startMultiTenantServer({
    port: TEST_PORT,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  let client;
  try {
    client = await connect('bp_insert');
    await client.query('CREATE TABLE big (id SERIAL PRIMARY KEY, payload TEXT)');

    // ~360KB of text — exceeds typical socket buffer size
    const bigPayload = 'x'.repeat(360_000);
    await client.query('INSERT INTO big (payload) VALUES ($1)', [bigPayload]);

    const res = await client.query('SELECT length(payload) AS len FROM big');
    expect(Number(res.rows[0].len)).toBe(360000);
  } finally {
    if (client) await client.end().catch(() => {});
    await router.stop();
    cleanup();
  }
}, 30_000);

test('Large SELECT result (500KB+) does not deadlock', async () => {
  cleanup();
  const router = await startMultiTenantServer({
    port: TEST_PORT,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  let client;
  try {
    client = await connect('bp_select');
    await client.query('CREATE TABLE chunks (id SERIAL PRIMARY KEY, data TEXT)');

    // Insert many rows that sum to >500KB
    const chunkSize = 10_000;
    const numChunks = 60; // 60 * 10KB = 600KB total
    const chunk = 'y'.repeat(chunkSize);

    for (let i = 0; i < numChunks; i++) {
      await client.query('INSERT INTO chunks (data) VALUES ($1)', [chunk]);
    }

    // Fetch all rows in a single result set (PG→Client backpressure)
    const res = await client.query('SELECT * FROM chunks');
    expect(res.rows.length).toBe(numChunks);
    expect(res.rows[0].data.length).toBe(chunkSize);
  } finally {
    if (client) await client.end().catch(() => {});
    await router.stop();
    cleanup();
  }
}, 30_000);

test('Large single query with multi-value INSERT (500KB+)', async () => {
  cleanup();
  const router = await startMultiTenantServer({
    port: TEST_PORT,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  let client;
  try {
    client = await connect('bp_multivalue');
    await client.query('CREATE TABLE items (id INT, val TEXT)');

    // Build a single INSERT with many value tuples to produce a large wire message
    const rowCount = 500;
    const rowValue = 'z'.repeat(1_000); // 1KB per row → ~500KB total
    const values = [];
    const params = [];
    for (let i = 0; i < rowCount; i++) {
      values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
      params.push(i, rowValue);
    }

    const sql = `INSERT INTO items (id, val) VALUES ${values.join(', ')}`;
    await client.query(sql, params);

    const res = await client.query('SELECT count(*)::int AS cnt FROM items');
    expect(res.rows[0].cnt).toBe(rowCount);
  } finally {
    if (client) await client.end().catch(() => {});
    await router.stop();
    cleanup();
  }
}, 30_000);

test('Concurrent large operations (5 clients x 300KB)', async () => {
  cleanup();
  const router = await startMultiTenantServer({
    port: TEST_PORT,
    baseDir: testDataDir,
    logLevel: 'warn',
  });

  try {
    const numClients = 5;
    const payloadSize = 300_000;
    const payload = 'c'.repeat(payloadSize);

    // Run all clients concurrently
    const results = await Promise.all(
      Array.from({ length: numClients }, async (_, i) => {
        const dbName = `bp_concurrent_${i}`;
        const client = await connect(dbName);
        await client.query('CREATE TABLE stress (id SERIAL PRIMARY KEY, data TEXT)');
        await client.query('INSERT INTO stress (data) VALUES ($1)', [payload]);

        const res = await client.query('SELECT length(data) AS len FROM stress');
        await client.end();
        return parseInt(res.rows[0].len, 10);
      })
    );

    // All clients should have successfully stored the full payload
    for (const len of results) {
      expect(len).toBe(payloadSize);
    }
  } finally {
    await router.stop();
    cleanup();
  }
}, 60_000);
