#!/usr/bin/env bun

/**
 * Quick Benchmark - Run against external pgserve instance
 * Usage: bun tests/quick-bench.js [port] [duration_seconds]
 */

import pg from 'pg';
const { Pool } = pg;

const PORT = parseInt(process.argv[2]) || 8433;
const DURATION_SEC = parseInt(process.argv[3]) || 30; // Run for 30 seconds by default
const CONNECTIONS = 20;

console.log(`
Quick Benchmark
===============
Target:      postgresql://127.0.0.1:${PORT}/bench
Connections: ${CONNECTIONS} concurrent
Duration:    ${DURATION_SEC} seconds
`);

const pool = new Pool({
  host: '127.0.0.1',
  port: PORT,
  database: 'bench',
  user: 'postgres',
  password: 'postgres',
  max: CONNECTIONS
});

let running = true;
let totalQueries = 0;
let errors = 0;
const latencies = [];

async function setup() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS bench_test (
        id SERIAL PRIMARY KEY,
        data TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query('TRUNCATE bench_test');
  } finally {
    client.release();
  }
}

async function runWorker(workerId) {
  let i = 0;
  while (running) {
    const start = performance.now();
    try {
      // Mix of operations
      const op = i % 3;
      if (op === 0) {
        await pool.query(
          'INSERT INTO bench_test (data) VALUES ($1)',
          [`worker-${workerId}-item-${i}-${Date.now()}`]
        );
      } else if (op === 1) {
        await pool.query('SELECT * FROM bench_test ORDER BY id DESC LIMIT 10');
      } else {
        await pool.query('SELECT COUNT(*) FROM bench_test');
      }
      latencies.push(performance.now() - start);
      totalQueries++;
      i++;
    } catch (err) {
      errors++;
      // Small delay on error to avoid tight loop
      await new Promise(r => setTimeout(r, 10));
    }
  }
}

async function run() {
  console.log('Setting up...');
  await setup();

  console.log(`Running for ${DURATION_SEC} seconds...\n`);
  const start = performance.now();

  // Start workers
  const workers = Array.from({ length: CONNECTIONS }, (_, i) => runWorker(i));

  // Progress updates every second
  const progressInterval = setInterval(() => {
    const elapsed = ((performance.now() - start) / 1000).toFixed(0);
    const qps = totalQueries / (elapsed || 1);
    process.stdout.write(`\r  ${elapsed}s elapsed | ${totalQueries} queries | ${qps.toFixed(0)} QPS | ${errors} errors    `);
  }, 1000);

  // Wait for duration
  await new Promise(r => setTimeout(r, DURATION_SEC * 1000));
  running = false;

  // Wait for workers to finish current query
  await Promise.all(workers.map(w => w.catch(() => {})));
  clearInterval(progressInterval);

  const totalTime = performance.now() - start;

  // Calculate stats
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avg = latencies.length > 0 ? sum / latencies.length : 0;
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const qps = (totalQueries / totalTime) * 1000;

  console.log(`\n
Results
=======
Total time:    ${(totalTime / 1000).toFixed(2)}s
Queries:       ${totalQueries}
Errors:        ${errors}
QPS:           ${qps.toFixed(0)} queries/sec

Latency:
  avg:         ${avg.toFixed(2)}ms
  p50:         ${p50.toFixed(2)}ms
  p95:         ${p95.toFixed(2)}ms
  p99:         ${p99.toFixed(2)}ms
`);

  await pool.end();
}

run().catch(console.error);
