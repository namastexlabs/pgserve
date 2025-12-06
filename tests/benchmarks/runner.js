#!/usr/bin/env node

/**
 * Benchmark Runner
 * Compares SQLite, PGlite, PostgreSQL Server, and pgserve performance
 */

import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { startMultiTenantServer } from '../../src/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pg from 'pg';

const { Pool } = pg;

// Global error handlers (suppress expected PGlite WASM ExitStatus errors)
process.on('unhandledRejection', (reason, promise) => {
  if (reason && reason.name === 'ExitStatus') return;
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  if (error && error.name === 'ExitStatus') return;
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

const RESULTS_DIR = new URL('./results', import.meta.url).pathname;

// PostgreSQL Server configuration (Docker with tmpfs for fair RAM-to-RAM comparison)
const POSTGRES_CONFIG = {
  host: 'localhost',
  port: 15432,
  user: 'postgres',
  password: 'benchpass',
  database: 'bench'
};

/**
 * Benchmark scenario configuration
 */
const scenarios = [
  {
    name: 'Concurrent Writes (10 agents)',
    description: 'Simulates 10 concurrent agents writing simultaneously',
    operations: [
      { type: 'INSERT', count: 100, concurrent: 10 }
    ]
  },
  {
    name: 'Mixed Workload (messages)',
    description: 'Simulates typical API message operations',
    operations: [
      { type: 'INSERT', count: 500 },
      { type: 'SELECT', count: 2000 },
      { type: 'UPDATE', count: 250 }
    ]
  },
  {
    name: 'Write Lock Contention',
    description: 'Stress test for lock handling with 50 concurrent writers',
    operations: [
      { type: 'INSERT', count: 100, concurrent: 50 }
    ]
  }
];

/**
 * Performance metrics
 */
class Metrics {
  constructor() {
    this.latencies = [];
    this.errors = 0;
    this.lockTimeouts = 0;
    this.startTime = 0;
    this.endTime = 0;
  }

  start() {
    this.startTime = Date.now();
  }

  end() {
    this.endTime = Date.now();
  }

  addLatency(ms) {
    this.latencies.push(ms);
  }

  addError(error) {
    this.errors++;
    if (error.message && error.message.includes('SQLITE_BUSY')) {
      this.lockTimeouts++;
    }
  }

  getThroughput() {
    const durationMs = this.endTime - this.startTime;
    const durationS = durationMs / 1000;
    return Math.round(this.latencies.length / durationS);
  }

  getPercentile(p) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.ceil((sorted.length * p) / 100) - 1;
    return sorted[Math.max(0, index)];
  }

  getReport() {
    return {
      throughput: this.getThroughput(),
      p50: this.getPercentile(50),
      p99: this.getPercentile(99),
      errors: this.errors,
      lockTimeouts: this.lockTimeouts,
      totalOps: this.latencies.length
    };
  }
}

/**
 * SQLite Benchmark
 */
async function benchmarkSQLite(scenario) {
  console.log('  🔸 Running SQLite benchmark...');

  const dbPath = path.join(RESULTS_DIR, 'sqlite-bench.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);

  // Setup schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      timestamp INTEGER
    )
  `);

  const metrics = new Metrics();
  metrics.start();

  // Run operations
  for (const op of scenario.operations) {
    if (op.type === 'INSERT') {
      const concurrent = op.concurrent || 1;
      const perThread = Math.floor(op.count / concurrent);

      for (let i = 0; i < concurrent; i++) {
        for (let j = 0; j < perThread; j++) {
          const start = Date.now();
          try {
            db.prepare('INSERT INTO messages (content, timestamp) VALUES (?, ?)').run(
              `Message ${i}-${j}`,
              Date.now()
            );
            metrics.addLatency(Date.now() - start);
          } catch (error) {
            metrics.addError(error);
          }
        }
      }
    } else if (op.type === 'SELECT') {
      for (let i = 0; i < op.count; i++) {
        const start = Date.now();
        try {
          db.prepare('SELECT * FROM messages LIMIT 10').all();
          metrics.addLatency(Date.now() - start);
        } catch (error) {
          metrics.addError(error);
        }
      }
    } else if (op.type === 'UPDATE') {
      for (let i = 0; i < op.count; i++) {
        const start = Date.now();
        try {
          db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(
            `Updated ${i}`,
            (i % 100) + 1
          );
          metrics.addLatency(Date.now() - start);
        } catch (error) {
          metrics.addError(error);
        }
      }
    }
  }

  metrics.end();
  db.close();

  return metrics.getReport();
}

/**
 * PGlite Benchmark (in-process WASM PostgreSQL)
 */
async function benchmarkPGlite(scenario) {
  console.log('  🔹 Running PGlite benchmark...');

  const dataDir = path.join(RESULTS_DIR, 'pglite-bench');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true });
  }

  const db = new PGlite(dataDir);

  // Setup schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      content TEXT,
      timestamp BIGINT
    )
  `);

  const metrics = new Metrics();
  metrics.start();

  // Run operations (PGlite is single-threaded, so concurrent = sequential)
  for (const op of scenario.operations) {
    if (op.type === 'INSERT') {
      const total = op.count;
      for (let i = 0; i < total; i++) {
        const start = Date.now();
        try {
          await db.query(
            'INSERT INTO messages (content, timestamp) VALUES ($1, $2)',
            [`Message ${i}`, Date.now()]
          );
          metrics.addLatency(Date.now() - start);
        } catch (error) {
          metrics.addError(error);
        }
      }
    } else if (op.type === 'SELECT') {
      for (let i = 0; i < op.count; i++) {
        const start = Date.now();
        try {
          await db.query('SELECT * FROM messages LIMIT 10');
          metrics.addLatency(Date.now() - start);
        } catch (error) {
          metrics.addError(error);
        }
      }
    } else if (op.type === 'UPDATE') {
      for (let i = 0; i < op.count; i++) {
        const start = Date.now();
        try {
          await db.query(
            'UPDATE messages SET content = $1 WHERE id = $2',
            [`Updated ${i}`, (i % 100) + 1]
          );
          metrics.addLatency(Date.now() - start);
        } catch (error) {
          metrics.addError(error);
        }
      }
    }
  }

  metrics.end();

  try {
    await db.close();
  } catch (e) {
    // Ignore ExitStatus errors from WASM cleanup
  }

  return metrics.getReport();
}

/**
 * PostgreSQL Server Benchmark (remote real PostgreSQL)
 */
async function benchmarkPostgreSQL(scenario) {
  console.log('  🔷 Running PostgreSQL Server benchmark...');

  const pool = new Pool({
    ...POSTGRES_CONFIG,
    max: 20
  });

  try {
    // Test connection first
    await pool.query('SELECT 1');

    // Setup schema
    await pool.query(`
      DROP TABLE IF EXISTS bench_messages;
      CREATE TABLE bench_messages (
        id SERIAL PRIMARY KEY,
        content TEXT,
        timestamp BIGINT
      )
    `);

    const metrics = new Metrics();
    metrics.start();

    // Run operations
    for (const op of scenario.operations) {
      if (op.type === 'INSERT') {
        const concurrent = op.concurrent || 1;
        const perThread = Math.floor(op.count / concurrent);

        const promises = [];
        for (let i = 0; i < concurrent; i++) {
          promises.push(
            (async () => {
              for (let j = 0; j < perThread; j++) {
                const start = Date.now();
                try {
                  await pool.query(
                    'INSERT INTO bench_messages (content, timestamp) VALUES ($1, $2)',
                    [`Message ${i}-${j}`, Date.now()]
                  );
                  metrics.addLatency(Date.now() - start);
                } catch (error) {
                  metrics.addError(error);
                }
              }
            })()
          );
        }

        await Promise.all(promises);
      } else if (op.type === 'SELECT') {
        for (let i = 0; i < op.count; i++) {
          const start = Date.now();
          try {
            await pool.query('SELECT * FROM bench_messages LIMIT 10');
            metrics.addLatency(Date.now() - start);
          } catch (error) {
            metrics.addError(error);
          }
        }
      } else if (op.type === 'UPDATE') {
        for (let i = 0; i < op.count; i++) {
          const start = Date.now();
          try {
            await pool.query(
              'UPDATE bench_messages SET content = $1 WHERE id = $2',
              [`Updated ${i}`, (i % 100) + 1]
            );
            metrics.addLatency(Date.now() - start);
          } catch (error) {
            metrics.addError(error);
          }
        }
      }
    }

    metrics.end();

    // Cleanup
    await pool.query('DROP TABLE IF EXISTS bench_messages');
    await pool.end();

    return metrics.getReport();
  } catch (error) {
    console.error('   PostgreSQL benchmark failed:', error.message);
    await pool.end();
    return { throughput: 0, p50: 0, p99: 0, errors: 1, lockTimeouts: 0, totalOps: 0, skipped: true };
  }
}

/**
 * pgserve Benchmark (our solution - embedded PostgreSQL with TRUE concurrency)
 * @param {Object} scenario - Benchmark scenario
 * @param {boolean} useRam - Use /dev/shm RAM storage (Linux only)
 */
async function benchmarkPgserve(scenario, useRam = false) {
  const mode = useRam ? 'RAM' : 'disk';
  console.log(`  🚀 Running pgserve (${mode}) benchmark...`);

  let server;
  try {
    // Start pgserve in memory mode (optionally with RAM storage)
    server = await startMultiTenantServer({
      port: useRam ? 18433 : 18432,
      logLevel: 'error',
      useRam
    });

    // Wait for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    const port = useRam ? 18433 : 18432;
    const pool = new Pool({
      host: 'localhost',
      port,
      database: 'bench_test',
      user: 'postgres',
      password: 'postgres',
      max: 20,
      connectionTimeoutMillis: 30000
    });

    // Wait for connection with retries
    let connected = false;
    for (let i = 0; i < 10; i++) {
      try {
        await pool.query('SELECT 1');
        connected = true;
        break;
      } catch (error) {
        if (i === 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!connected) {
      throw new Error('Failed to connect to pgserve');
    }

    // Setup schema
    await pool.query(`
      DROP TABLE IF EXISTS bench_messages;
      CREATE TABLE bench_messages (
        id SERIAL PRIMARY KEY,
        content TEXT,
        timestamp BIGINT
      )
    `);

    const metrics = new Metrics();
    metrics.start();

    // Run operations (TRUE concurrent - pgserve handles this natively)
    for (const op of scenario.operations) {
      if (op.type === 'INSERT') {
        const concurrent = op.concurrent || 1;
        const perThread = Math.floor(op.count / concurrent);

        const promises = [];
        for (let i = 0; i < concurrent; i++) {
          promises.push(
            (async () => {
              for (let j = 0; j < perThread; j++) {
                const start = Date.now();
                try {
                  await pool.query(
                    'INSERT INTO bench_messages (content, timestamp) VALUES ($1, $2)',
                    [`Message ${i}-${j}`, Date.now()]
                  );
                  metrics.addLatency(Date.now() - start);
                } catch (error) {
                  metrics.addError(error);
                }
              }
            })()
          );
        }

        await Promise.all(promises);
      } else if (op.type === 'SELECT') {
        for (let i = 0; i < op.count; i++) {
          const start = Date.now();
          try {
            await pool.query('SELECT * FROM bench_messages LIMIT 10');
            metrics.addLatency(Date.now() - start);
          } catch (error) {
            metrics.addError(error);
          }
        }
      } else if (op.type === 'UPDATE') {
        for (let i = 0; i < op.count; i++) {
          const start = Date.now();
          try {
            await pool.query(
              'UPDATE bench_messages SET content = $1 WHERE id = $2',
              [`Updated ${i}`, (i % 100) + 1]
            );
            metrics.addLatency(Date.now() - start);
          } catch (error) {
            metrics.addError(error);
          }
        }
      }
    }

    metrics.end();

    // Cleanup
    await pool.end();
    await server.stop();

    return metrics.getReport();
  } catch (error) {
    console.error(`   pgserve (${mode}) benchmark failed:`, error.message);
    if (server) {
      try { await server.stop(); } catch (e) {}
    }
    return { throughput: 0, p50: 0, p99: 0, errors: 1, lockTimeouts: 0, totalOps: 0, skipped: true };
  }
}

/**
 * Generate comparison report
 */
function generateReport(results) {
  const report = {
    timestamp: new Date().toISOString(),
    scenarios: results
  };

  // Save JSON
  const jsonPath = path.join(RESULTS_DIR, 'benchmark-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Generate markdown
  let md = '# Benchmark Results\n\n';
  md += `**Date:** ${new Date().toLocaleString()}\n\n`;
  md += '## Quick Start\n\n';
  md += '```bash\n';
  md += '# Zero install - just run!\n';
  md += 'npx pgserve\n\n';
  md += '# Connect from any PostgreSQL client\n';
  md += 'psql postgresql://localhost:5432/mydb\n';
  md += '```\n\n';

  for (const scenario of results) {
    md += `## ${scenario.name}\n\n`;
    md += `${scenario.description}\n\n`;

    const { sqlite, pglite, postgres, pgserve, pgserveRam } = scenario;
    const hasRam = pgserveRam && !pgserveRam.skipped;

    if (hasRam) {
      // Extended table with RAM column
      md += '```\n';
      md += '┌─────────────────┬──────────┬──────────┬──────────┬──────────┬─────────────┬─────────────┐\n';
      md += '│ Metric          │ SQLite   │ PGlite   │ PostgreSQL│ pgserve  │ pgserve RAM │ Winner      │\n';
      md += '├─────────────────┼──────────┼──────────┼──────────┼──────────┼─────────────┼─────────────┤\n';

      // Find winners (include RAM)
      const throughputs = { sqlite: sqlite.throughput, pglite: pglite.throughput, postgres: postgres.throughput, pgserve: pgserve.throughput, pgserveRam: pgserveRam.throughput };
      const p50s = { sqlite: sqlite.p50, pglite: pglite.p50, postgres: postgres.p50, pgserve: pgserve.p50, pgserveRam: pgserveRam.p50 };
      const p99s = { sqlite: sqlite.p99, pglite: pglite.p99, postgres: postgres.p99, pgserve: pgserve.p99, pgserveRam: pgserveRam.p99 };
      const errors = { sqlite: sqlite.errors, pglite: pglite.errors, postgres: postgres.errors, pgserve: pgserve.errors, pgserveRam: pgserveRam.errors };

      const getMaxKey = (obj) => Object.entries(obj).reduce((a, b) => a[1] > b[1] ? a : b)[0];
      const getMinKey = (obj) => Object.entries(obj).filter(([k,v]) => v > 0 || k === 'sqlite').reduce((a, b) => a[1] < b[1] ? a : b)[0];
      const getMinErrorKey = (obj) => Object.entries(obj).reduce((a, b) => a[1] <= b[1] ? a : b)[0];

      const nameMap = { sqlite: 'SQLite', pglite: 'PGlite', postgres: 'PostgreSQL', pgserve: 'pgserve', pgserveRam: 'pgserve RAM' };

      const pad = (s, n) => String(s).padEnd(n);

      md += `│ Throughput (qps)│ ${pad(sqlite.throughput, 8)} │ ${pad(pglite.throughput, 8)} │ ${pad(postgres.throughput, 9)} │ ${pad(pgserve.throughput, 8)} │ ${pad(pgserveRam.throughput, 11)} │ ${pad(nameMap[getMaxKey(throughputs)], 11)} │\n`;
      md += `│ P50 latency (ms)│ ${pad(sqlite.p50, 8)} │ ${pad(pglite.p50, 8)} │ ${pad(postgres.p50, 9)} │ ${pad(pgserve.p50, 8)} │ ${pad(pgserveRam.p50, 11)} │ ${pad(nameMap[getMinKey(p50s)], 11)} │\n`;
      md += `│ P99 latency (ms)│ ${pad(sqlite.p99, 8)} │ ${pad(pglite.p99, 8)} │ ${pad(postgres.p99, 9)} │ ${pad(pgserve.p99, 8)} │ ${pad(pgserveRam.p99, 11)} │ ${pad(nameMap[getMinKey(p99s)], 11)} │\n`;
      md += `│ Errors          │ ${pad(sqlite.errors, 8)} │ ${pad(pglite.errors, 8)} │ ${pad(postgres.errors, 9)} │ ${pad(pgserve.errors, 8)} │ ${pad(pgserveRam.errors, 11)} │ ${pad(nameMap[getMinErrorKey(errors)], 11)} │\n`;
      md += '└─────────────────┴──────────┴──────────┴──────────┴──────────┴─────────────┴─────────────┘\n';
      md += '```\n\n';

      // Analysis with RAM comparison
      const winner = nameMap[getMaxKey(throughputs)];
      if (winner === 'pgserve RAM') {
        const vsDisk = pgserve.throughput > 0 ? ((pgserveRam.throughput / pgserve.throughput - 1) * 100).toFixed(1) : 'N/A';
        const vsPGlite = pglite.throughput > 0 ? ((pgserveRam.throughput / pglite.throughput - 1) * 100).toFixed(1) : 'N/A';
        md += `**pgserve RAM wins!** ${vsDisk}% faster than disk mode, ${vsPGlite}% faster than PGlite.\n\n`;
      } else if (winner === 'pgserve') {
        const vsPGlite = pglite.throughput > 0 ? ((pgserve.throughput / pglite.throughput - 1) * 100).toFixed(1) : 'N/A';
        md += `**pgserve wins!** ${vsPGlite}% faster than PGlite for concurrent workloads.\n\n`;
      } else {
        md += `**${winner} wins** this scenario.\n\n`;
      }
    } else {
      // Original table without RAM column
      md += '```\n';
      md += '┌─────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐\n';
      md += '│ Metric          │ SQLite   │ PGlite   │ PostgreSQL│ pgserve  │ Winner   │\n';
      md += '├─────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤\n';

      // Find winners
      const throughputs = { sqlite: sqlite.throughput, pglite: pglite.throughput, postgres: postgres.throughput, pgserve: pgserve.throughput };
      const p50s = { sqlite: sqlite.p50, pglite: pglite.p50, postgres: postgres.p50, pgserve: pgserve.p50 };
      const p99s = { sqlite: sqlite.p99, pglite: pglite.p99, postgres: postgres.p99, pgserve: pgserve.p99 };
      const errors = { sqlite: sqlite.errors, pglite: pglite.errors, postgres: postgres.errors, pgserve: pgserve.errors };

      const getMaxKey = (obj) => Object.entries(obj).reduce((a, b) => a[1] > b[1] ? a : b)[0];
      const getMinKey = (obj) => Object.entries(obj).filter(([k,v]) => v > 0 || k === 'sqlite').reduce((a, b) => a[1] < b[1] ? a : b)[0];
      const getMinErrorKey = (obj) => Object.entries(obj).reduce((a, b) => a[1] <= b[1] ? a : b)[0];

      const nameMap = { sqlite: 'SQLite', pglite: 'PGlite', postgres: 'PostgreSQL', pgserve: 'pgserve' };

      const pad = (s, n) => String(s).padEnd(n);

      md += `│ Throughput (qps)│ ${pad(sqlite.throughput, 8)} │ ${pad(pglite.throughput, 8)} │ ${pad(postgres.throughput, 9)} │ ${pad(pgserve.throughput, 8)} │ ${pad(nameMap[getMaxKey(throughputs)], 8)} │\n`;
      md += `│ P50 latency (ms)│ ${pad(sqlite.p50, 8)} │ ${pad(pglite.p50, 8)} │ ${pad(postgres.p50, 9)} │ ${pad(pgserve.p50, 8)} │ ${pad(nameMap[getMinKey(p50s)], 8)} │\n`;
      md += `│ P99 latency (ms)│ ${pad(sqlite.p99, 8)} │ ${pad(pglite.p99, 8)} │ ${pad(postgres.p99, 9)} │ ${pad(pgserve.p99, 8)} │ ${pad(nameMap[getMinKey(p99s)], 8)} │\n`;
      md += `│ Errors          │ ${pad(sqlite.errors, 8)} │ ${pad(pglite.errors, 8)} │ ${pad(postgres.errors, 9)} │ ${pad(pgserve.errors, 8)} │ ${pad(nameMap[getMinErrorKey(errors)], 8)} │\n`;
      md += '└─────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘\n';
      md += '```\n\n';

      // Analysis
      const winner = nameMap[getMaxKey(throughputs)];
      if (winner === 'pgserve') {
        const vsPGlite = pglite.throughput > 0 ? ((pgserve.throughput / pglite.throughput - 1) * 100).toFixed(1) : 'N/A';
        md += `**pgserve wins!** ${vsPGlite}% faster than PGlite for concurrent workloads.\n\n`;
      } else {
        md += `**${winner} wins** this scenario.\n\n`;
      }
    }
  }

  md += '---\n\n';
  md += '## Why pgserve?\n\n';
  md += '- **TRUE Concurrency**: Native PostgreSQL process forking\n';
  md += '- **RAM Mode**: `--ram` flag for /dev/shm storage (Linux)\n';
  md += '- **Zero Config**: Just run `npx pgserve`\n';
  md += '- **Auto-Provision**: Databases created on first connection\n';
  md += '- **PostgreSQL 17.7**: Latest stable, native binaries\n';

  const mdPath = path.join(RESULTS_DIR, 'benchmark-results.md');
  fs.writeFileSync(mdPath, md);

  console.log(`\nResults saved to:`);
  console.log(`   JSON: ${jsonPath}`);
  console.log(`   Markdown: ${mdPath}\n`);

  return report;
}

/**
 * Main runner
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  pgserve Benchmark Suite                                       ║');
  console.log('║  Comparing: SQLite | PGlite | PostgreSQL | pgserve            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const results = [];

  // Check if RAM mode is available (Linux only with /dev/shm)
  const canUseRam = os.platform() === 'linux' && fs.existsSync('/dev/shm');
  if (canUseRam) {
    console.log('💾 RAM mode available (/dev/shm detected)\n');
  } else {
    console.log('⚠️  RAM mode not available (Linux /dev/shm required)\n');
  }

  for (const scenario of scenarios) {
    console.log(`\n📊 Scenario: ${scenario.name}`);
    console.log(`   ${scenario.description}\n`);

    const sqlite = await benchmarkSQLite(scenario);
    const pglite = await benchmarkPGlite(scenario);
    const postgres = await benchmarkPostgreSQL(scenario);
    const pgserve = await benchmarkPgserve(scenario, false);  // disk mode
    const pgserveRam = canUseRam
      ? await benchmarkPgserve(scenario, true)  // RAM mode
      : { throughput: 0, p50: 0, p99: 0, errors: 0, lockTimeouts: 0, totalOps: 0, skipped: true };

    results.push({
      name: scenario.name,
      description: scenario.description,
      sqlite,
      pglite,
      postgres,
      pgserve,
      pgserveRam
    });

    console.log(`\n   SQLite:        ${sqlite.throughput} qps, P50=${sqlite.p50}ms, errors=${sqlite.errors}`);
    console.log(`   PGlite:        ${pglite.throughput} qps, P50=${pglite.p50}ms, errors=${pglite.errors}`);
    console.log(`   PostgreSQL:    ${postgres.throughput} qps, P50=${postgres.p50}ms, errors=${postgres.errors}`);
    console.log(`   pgserve:       ${pgserve.throughput} qps, P50=${pgserve.p50}ms, errors=${pgserve.errors}`);
    if (canUseRam) {
      console.log(`   pgserve (RAM): ${pgserveRam.throughput} qps, P50=${pgserveRam.p50}ms, errors=${pgserveRam.errors}`);
    }
  }

  console.log('\n📄 Generating report...\n');
  generateReport(results);

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Benchmarks Complete!                                         ║');
  console.log('║                                                                ║');
  console.log('║  Try it yourself:  npx pgserve                                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
