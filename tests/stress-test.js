#!/usr/bin/env bun

/**
 * pgserve Stress Test Suite
 *
 * Like PassMark but for PostgreSQL - progressive load testing with multiple scenarios.
 * Perfect for filming terminal under stress.
 *
 * Usage: bun tests/stress-test.js [port]
 */

import pg from 'pg';
const { Pool } = pg;

const PORT = parseInt(process.argv[2]) || 8433;

// ANSI colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

const results = [];
let globalPool = null;

/**
 * Create a connection pool
 */
function createPool(maxConnections) {
  return new Pool({
    host: '127.0.0.1',
    port: PORT,
    database: 'stresstest',
    user: 'postgres',
    password: 'postgres',
    max: maxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

/**
 * Setup test tables
 */
async function setup(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS stress_users CASCADE;
      DROP TABLE IF EXISTS stress_orders CASCADE;
      DROP TABLE IF EXISTS stress_logs CASCADE;

      CREATE TABLE stress_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE stress_orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        amount DECIMAL(10,2),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE stress_logs (
        id SERIAL PRIMARY KEY,
        level TEXT,
        message TEXT,
        data JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX idx_orders_user ON stress_orders(user_id);
      CREATE INDEX idx_orders_status ON stress_orders(status);
      CREATE INDEX idx_logs_level ON stress_logs(level);
    `);
  } finally {
    client.release();
  }
}

/**
 * Print banner
 */
function banner() {
  console.log(`
${C.cyan}${C.bold}╔════════════════════════════════════════════════════════════════╗
║                   pgserve STRESS TEST SUITE                    ║
║                                                                ║
║  Progressive load testing with multiple scenarios              ║
╚════════════════════════════════════════════════════════════════╝${C.reset}

${C.dim}Target: postgresql://127.0.0.1:${PORT}/stresstest${C.reset}
`);
}

/**
 * Print section header
 */
function section(name, description) {
  console.log(`
${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}
${C.bold}${C.cyan}▶ ${name}${C.reset}
${C.dim}${description}${C.reset}
${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}
`);
}

/**
 * Progress bar
 */
function progressBar(current, total, width = 30) {
  const pct = Math.min(1, Math.max(0, current / total || 0));
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  const empty = Math.max(0, width - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${(pct * 100).toFixed(0)}%`;
}

/**
 * Run a test phase
 */
async function runPhase(name, config) {
  const { connections, duration, workload } = config;

  const pool = createPool(connections);
  const latencies = [];
  let queries = 0;
  let errors = 0;
  let running = true;

  const startTime = performance.now();

  // Worker function
  async function worker(id) {
    while (running) {
      const start = performance.now();
      try {
        await workload(pool, id);
        latencies.push(performance.now() - start);
        queries++;
      } catch (err) {
        // Only count errors while test is running (not pool shutdown errors)
        if (running) {
          errors++;
        }
      }
    }
  }

  // Start workers
  const workers = Array.from({ length: connections }, (_, i) => worker(i));

  // Progress display
  const progressInterval = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    const qps = queries / elapsed;
    const progress = progressBar(elapsed, duration);
    process.stdout.write(`\r  ${progress} | ${queries.toLocaleString()} queries | ${qps.toFixed(0)} QPS | ${errors} errors    `);
  }, 200);

  // Wait for duration
  await new Promise(r => setTimeout(r, duration * 1000));
  running = false;

  // End pool immediately to unblock workers waiting for connections
  // This is necessary because workers may be stuck in pool.connect() or pool.query()
  await pool.end().catch(() => {});

  // Wait for workers to finish (with timeout in case any are still stuck)
  await Promise.race([
    Promise.allSettled(workers),
    new Promise(r => setTimeout(r, 2000)) // 2 second grace period
  ]);
  clearInterval(progressInterval);

  const totalTime = (performance.now() - startTime) / 1000;

  // Calculate stats
  latencies.sort((a, b) => a - b);
  const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const qps = queries / totalTime;

  const result = {
    name,
    connections,
    duration: totalTime,
    queries,
    errors,
    qps,
    latency: { avg, p50, p95, p99 }
  };

  results.push(result);

  console.log(`\r  ${C.green}✓${C.reset} Complete: ${queries.toLocaleString()} queries in ${totalTime.toFixed(1)}s = ${C.bold}${qps.toFixed(0)} QPS${C.reset}    `);
  console.log(`    ${C.dim}Latency: avg=${avg.toFixed(1)}ms p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms${C.reset}`);

  return result;
}

// ============================================================================
// WORKLOADS
// ============================================================================

const workloads = {
  // Pure inserts
  writeHeavy: async (pool, workerId) => {
    await pool.query(
      'INSERT INTO stress_logs (level, message, data) VALUES ($1, $2, $3)',
      ['info', `Worker ${workerId} log entry`, JSON.stringify({ ts: Date.now(), worker: workerId })]
    );
  },

  // Pure reads
  readHeavy: async (pool) => {
    await pool.query('SELECT * FROM stress_logs ORDER BY id DESC LIMIT 50');
  },

  // Mixed CRUD
  mixed: async (pool, workerId) => {
    const op = Math.random();
    if (op < 0.3) {
      // 30% writes
      await pool.query(
        'INSERT INTO stress_orders (user_id, amount, status) VALUES ($1, $2, $3)',
        [Math.floor(Math.random() * 1000), Math.random() * 1000, 'pending']
      );
    } else if (op < 0.5) {
      // 20% updates
      await pool.query(
        "UPDATE stress_orders SET status = $1 WHERE id = (SELECT id FROM stress_orders WHERE status = 'pending' LIMIT 1)",
        ['completed']
      );
    } else {
      // 50% reads
      await pool.query('SELECT * FROM stress_orders WHERE status = $1 LIMIT 20', ['pending']);
    }
  },

  // Complex queries with joins
  complex: async (pool) => {
    await pool.query(`
      SELECT o.*, COUNT(*) OVER() as total
      FROM stress_orders o
      WHERE o.created_at > NOW() - INTERVAL '1 hour'
      ORDER BY o.created_at DESC
      LIMIT 10
    `);
  },

  // Transaction heavy
  transactions: async (pool) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO stress_users (name, email) VALUES ($1, $2) RETURNING id',
        [`User-${Date.now()}`, `user-${Date.now()}@test.com`]
      );
      await client.query(
        'INSERT INTO stress_orders (user_id, amount) VALUES (currval(pg_get_serial_sequence(\'stress_users\', \'id\')), $1)',
        [Math.random() * 500]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

async function runSuite() {
  banner();

  console.log(`${C.dim}Connecting and setting up test database...${C.reset}`);
  globalPool = createPool(5);
  await setup(globalPool);
  console.log(`${C.green}✓${C.reset} Setup complete\n`);

  // -------------------------------------------------------------------------
  // TEST 1: Connection Ramp-Up
  // -------------------------------------------------------------------------
  section('TEST 1: Connection Ramp-Up', 'Gradually increasing concurrent connections');

  for (const conns of [10, 50, 100, 250, 500]) {
    console.log(`\n  ${C.cyan}→ ${conns} connections${C.reset}`);
    await runPhase(`ramp-${conns}`, {
      connections: conns,
      duration: 10,
      workload: workloads.mixed
    });
    await new Promise(r => setTimeout(r, 1000)); // Brief pause between phases
  }

  // -------------------------------------------------------------------------
  // TEST 2: Write Stress
  // -------------------------------------------------------------------------
  section('TEST 2: Write Stress', 'Heavy INSERT workload - 200 connections, 15 seconds');

  await runPhase('write-stress', {
    connections: 200,
    duration: 15,
    workload: workloads.writeHeavy
  });

  // -------------------------------------------------------------------------
  // TEST 3: Read Stress
  // -------------------------------------------------------------------------
  section('TEST 3: Read Stress', 'Heavy SELECT workload - 200 connections, 15 seconds');

  await runPhase('read-stress', {
    connections: 200,
    duration: 15,
    workload: workloads.readHeavy
  });

  // -------------------------------------------------------------------------
  // TEST 4: Mixed Workload
  // -------------------------------------------------------------------------
  section('TEST 4: Mixed Workload', 'Real-world CRUD simulation - 300 connections, 20 seconds');

  await runPhase('mixed-heavy', {
    connections: 300,
    duration: 20,
    workload: workloads.mixed
  });

  // -------------------------------------------------------------------------
  // TEST 5: Transaction Stress
  // -------------------------------------------------------------------------
  section('TEST 5: Transaction Stress', 'Multi-statement transactions - 150 connections, 15 seconds');

  await runPhase('transactions', {
    connections: 150,
    duration: 15,
    workload: workloads.transactions
  });

  // -------------------------------------------------------------------------
  // TEST 6: Peak Load
  // -------------------------------------------------------------------------
  section('TEST 6: Peak Load', 'Maximum stress - 500 connections, 20 seconds');

  await runPhase('peak-load', {
    connections: 500,
    duration: 20,
    workload: workloads.mixed
  });

  // -------------------------------------------------------------------------
  // TEST 7: Extreme Load
  // -------------------------------------------------------------------------
  section('TEST 7: Extreme Load', 'Near-limit stress - 750 connections, 15 seconds');

  await runPhase('extreme-load', {
    connections: 750,
    duration: 15,
    workload: workloads.mixed
  });

  // -------------------------------------------------------------------------
  // FINAL REPORT
  // -------------------------------------------------------------------------
  await globalPool.end();

  console.log(`
${C.cyan}${C.bold}
╔════════════════════════════════════════════════════════════════╗
║                      FINAL RESULTS                             ║
╚════════════════════════════════════════════════════════════════╝${C.reset}
`);

  // Summary table
  console.log(`${C.bold}Test Name              Conn   Queries      QPS     Avg     P95     P99   Errors${C.reset}`);
  console.log(`${'─'.repeat(85)}`);

  let totalQueries = 0;
  let totalErrors = 0;
  let peakQps = 0;

  for (const r of results) {
    const name = r.name.padEnd(20);
    const conn = String(r.connections).padStart(4);
    const queries = r.queries.toLocaleString().padStart(10);
    const qps = r.qps.toFixed(0).padStart(7);
    const avg = r.latency.avg.toFixed(1).padStart(6) + 'ms';
    const p95 = r.latency.p95.toFixed(1).padStart(6) + 'ms';
    const p99 = r.latency.p99.toFixed(1).padStart(6) + 'ms';
    const errors = String(r.errors).padStart(6);

    const color = r.errors > 0 ? C.yellow : C.green;
    console.log(`${color}${name} ${conn} ${queries} ${qps} ${avg} ${p95} ${p99} ${errors}${C.reset}`);

    totalQueries += r.queries;
    totalErrors += r.errors;
    if (r.qps > peakQps) peakQps = r.qps;
  }

  console.log(`${'─'.repeat(85)}`);

  // Score calculation (arbitrary but fun)
  const score = Math.round((peakQps * 0.5) + (totalQueries / 1000) - (totalErrors * 10));

  console.log(`
${C.bold}Summary:${C.reset}
  Total Queries:    ${totalQueries.toLocaleString()}
  Total Errors:     ${totalErrors}
  Peak QPS:         ${peakQps.toFixed(0)}

${C.magenta}${C.bold}╔═══════════════════════════════════╗
║  PGSERVE SCORE: ${String(score).padStart(6)}            ║
╚═══════════════════════════════════╝${C.reset}
`);
}

// Run
runSuite().catch(err => {
  console.error(`${C.red}Error:${C.reset}`, err);
  process.exit(1);
});
