#!/usr/bin/env bun

/**
 * Benchmark Runner
 * Compares SQLite, PGlite, PostgreSQL Server, and pgserve performance
 *
 * 100% Bun-native: Uses bun:sqlite instead of better-sqlite3
 */

import { Database } from 'bun:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { startMultiTenantServer } from '../../src/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pg from 'pg';
import { loadEmbeddings, generateQueryVectors, formatPgVector, getEmbeddingsPath, getGroundTruth, calculateRecall } from './vector-generator.js';

const { Pool } = pg;

// ============================================================================
// ANSI Colors and Visual Utilities (stress-test style)
// ============================================================================
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
};

/**
 * Print benchmark banner
 */
function banner() {
  console.log(`
${C.cyan}${C.bold}╔════════════════════════════════════════════════════════════════╗
║           pgserve UNIFIED BENCHMARK SUITE                      ║
║                                                                ║
║  Comparing: SQLite │ PGlite │ PostgreSQL │ pgserve            ║
╚════════════════════════════════════════════════════════════════╝${C.reset}
`);
}

/**
 * Print section header
 */
function section(name, description) {
  console.log(`
${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}
${C.bold}${C.cyan}▶ ${name}${C.reset}
${C.dim}  ${description}${C.reset}
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
  return `[${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset}] ${(pct * 100).toFixed(0)}%`;
}

/**
 * Calculate score for an engine
 * Higher is better - weighted combination of throughput and latency
 */
function calculateScore(results) {
  if (results.skipped) return 0;

  // Score formula:
  // - Base: throughput QPS (main factor)
  // - Bonus: low latency (P99 < 10ms gets bonus)
  // - Penalty: errors
  const throughputScore = results.throughput || 0;
  const latencyBonus = results.p99 > 0 ? Math.max(0, (10 - results.p99) * 10) : 0;
  const errorPenalty = (results.errors || 0) * 100;

  return Math.round(throughputScore + latencyBonus - errorPenalty);
}

/**
 * Print final results table with scores
 */
function printFinalResults(allResults, vectorResults, canUseRam) {
  console.log(`
${C.cyan}${C.bold}
╔════════════════════════════════════════════════════════════════╗
║                      FINAL RESULTS                             ║
╚════════════════════════════════════════════════════════════════╝${C.reset}
`);

  // Aggregate results per engine
  // Note: recallCount tracks only SEARCH scenarios (INSERT has 'N/A' recall)
  const engines = {
    sqlite: { name: 'SQLite', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
    pglite: { name: 'PGlite', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
    postgres: { name: 'PostgreSQL', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0, skipped: false },
    pgserve: { name: 'pgserve (disk)', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
    pgserveRam: { name: 'pgserve (RAM)', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
  };

  // Aggregate CRUD results
  for (const r of allResults) {
    for (const [key, eng] of Object.entries(engines)) {
      const data = r[key];
      if (data && !data.skipped) {
        eng.crudQps += data.throughput || 0;
        eng.p50 += data.p50 || 0;
        eng.p99 += data.p99 || 0;
        eng.errors += data.errors || 0;
        eng.count++;
      } else if (data?.skipped) {
        eng.skipped = true;
      }
    }
  }

  // Aggregate Vector results (with recall)
  // Note: INSERT scenarios have recall='N/A', only SEARCH scenarios have numeric recall
  for (const r of vectorResults) {
    for (const [key, eng] of Object.entries(engines)) {
      const data = r[key];
      if (data && !data.skipped) {
        eng.vecQps += data.throughput || 0;
        eng.vecCount++;
        // Only count recall for SEARCH scenarios (not INSERT which has 'N/A')
        const recallValue = parseFloat(data.recall);
        if (!isNaN(recallValue)) {
          eng.vecRecall += recallValue;
          eng.recallCount++;
        }
      }
    }
  }

  // Average the results
  for (const eng of Object.values(engines)) {
    if (eng.count > 0) {
      eng.crudQps = Math.round(eng.crudQps / eng.count);
      eng.p50 = (eng.p50 / eng.count).toFixed(1);
      eng.p99 = (eng.p99 / eng.count).toFixed(1);
    }
    if (eng.vecCount > 0) {
      eng.vecQps = Math.round(eng.vecQps / eng.vecCount);
    } else {
      eng.vecQps = 0;
    }
    // Average recall only from SEARCH scenarios (recallCount), not INSERT scenarios
    if (eng.recallCount > 0) {
      eng.vecRecall = (eng.vecRecall / eng.recallCount).toFixed(1);
    } else {
      eng.vecRecall = 'N/A';
    }
    eng.score = Math.round(eng.crudQps * 0.6 + eng.vecQps * 0.4 - eng.errors * 10);
  }

  // Print table header (with Recall column)
  const hasVec = vectorResults.length > 0;
  if (hasVec) {
    console.log(`${C.bold}Engine            │ CRUD QPS │ Vec QPS │ Recall │   P50   │   P99   │ Errors │  SCORE${C.reset}`);
    console.log(`${'─'.repeat(90)}`);
  } else {
    console.log(`${C.bold}Engine            │ CRUD QPS │   P50   │   P99   │ Errors │  SCORE${C.reset}`);
    console.log(`${'─'.repeat(70)}`);
  }

  // Print each engine row
  const engineOrder = ['sqlite', 'pglite', 'postgres', 'pgserve'];
  if (canUseRam) engineOrder.push('pgserveRam');

  let maxScore = 0;
  let winner = '';

  for (const key of engineOrder) {
    const eng = engines[key];
    if (eng.skipped) {
      if (hasVec) {
        console.log(`${C.dim}${eng.name.padEnd(17)} │ ${'-'.padStart(8)} │ ${'-'.padStart(7)} │ ${'-'.padStart(6)} │ ${'-'.padStart(7)} │ ${'-'.padStart(7)} │ ${'-'.padStart(6)} │ ${'-'.padStart(7)}${C.reset}`);
      } else {
        console.log(`${C.dim}${eng.name.padEnd(17)} │ ${'-'.padStart(8)} │ ${'-'.padStart(7)} │ ${'-'.padStart(7)} │ ${'-'.padStart(6)} │ ${'-'.padStart(7)}${C.reset}`);
      }
      continue;
    }

    const color = eng.errors > 0 ? C.yellow : C.green;
    const scoreColor = eng.score > maxScore ? C.magenta + C.bold : color;

    if (eng.score > maxScore) {
      maxScore = eng.score;
      winner = eng.name;
    }

    if (hasVec) {
      // vecRecall is 'N/A' for INSERT-only scenarios, or a numeric string like '100.0' for SEARCH
      const recallStr = eng.vecRecall !== 'N/A' ? `${eng.vecRecall}%` : 'N/A';
      const vecQpsStr = eng.vecCount > 0 ? eng.vecQps.toLocaleString() : 'N/A';
      console.log(`${color}${eng.name.padEnd(17)} │ ${String(eng.crudQps.toLocaleString()).padStart(8)} │ ${vecQpsStr.padStart(7)} │ ${recallStr.padStart(6)} │ ${(eng.p50 + 'ms').padStart(7)} │ ${(eng.p99 + 'ms').padStart(7)} │ ${String(eng.errors).padStart(6)} │ ${scoreColor}${String(eng.score.toLocaleString()).padStart(7)}${C.reset}`);
    } else {
      console.log(`${color}${eng.name.padEnd(17)} │ ${String(eng.crudQps.toLocaleString()).padStart(8)} │ ${(eng.p50 + 'ms').padStart(7)} │ ${(eng.p99 + 'ms').padStart(7)} │ ${String(eng.errors).padStart(6)} │ ${scoreColor}${String(eng.score.toLocaleString()).padStart(7)}${C.reset}`);
    }
  }

  console.log(`${'─'.repeat(hasVec ? 90 : 70)}`);

  // Winner announcement
  console.log(`
${C.magenta}${C.bold}╔═══════════════════════════════════════════════════╗
║  🏆 WINNER: ${winner.padEnd(20)} SCORE: ${String(maxScore).padStart(7)}  ║
╚═══════════════════════════════════════════════════╝${C.reset}
`);
}

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
  port: 5433,  // pgvector/pgvector:pg17 Docker container
  user: 'postgres',
  password: 'postgres',
  database: 'postgres'
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
 * Vector benchmark scenarios (pgvector)
 * Requires: --include-vector flag
 */
/**
 * Vector benchmark scenarios
 * Following industry-standard methodology (ANN-Benchmarks, Qdrant, VectorDBBench):
 * - Measure Recall@k alongside QPS
 * - Compare approximate results to brute-force ground truth
 * - Report both metrics together (can't compare QPS without knowing recall)
 */
const vectorScenarios = [
  {
    name: 'Vector INSERT (1000 vectors)',
    description: 'Bulk insert performance - where RAM mode shows benefits',
    type: 'INSERT',
    dimension: 1536,
    insertCount: 1000,  // Insert 1000 vectors to measure write speed
  },
  {
    name: 'k-NN Search (k=10)',
    description: 'Recall@10 and QPS on 10k vectors, 100 queries',
    type: 'SEARCH',
    dimension: 1536,
    corpusSize: 10000,
    queryCount: 100,
    k: 10,
    warmupQueries: 20  // Warm-up before measuring
  },
  {
    name: 'k-NN Search (k=100)',
    description: 'Recall@100 and QPS on 10k vectors - harder recall target',
    type: 'SEARCH',
    dimension: 1536,
    corpusSize: 10000,
    queryCount: 100,
    k: 100,
    warmupQueries: 20
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
    console.error('   PostgreSQL benchmark skipped:', error.message);
    await pool.end().catch(() => {});
    return { throughput: 0, p50: 0, p99: 0, errors: 0, lockTimeouts: 0, totalOps: 0, skipped: true };
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

// ============================================================================
// VECTOR BENCHMARKS (pgvector)
// ============================================================================

/**
 * PGlite Vector Benchmark
 * Supports both INSERT and SEARCH scenarios
 */
async function benchmarkPGliteVector(scenario, embeddings, queryVectors, groundTruth) {
  console.log('  🔹 Running PGlite vector benchmark...');

  const dataDir = path.join(RESULTS_DIR, 'pglite-vector-bench');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true });
  }

  try {
    // Create PGlite with pgvector extension
    const db = new PGlite(dataDir, { extensions: { vector } });
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');

    // Setup schema
    await db.exec(`
      DROP TABLE IF EXISTS embeddings;
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY,
        vector vector(${scenario.dimension})
      )
    `);

    // INSERT scenario - measure insert speed
    if (scenario.type === 'INSERT') {
      console.log(`    Inserting ${scenario.insertCount} vectors (measured)...`);
      const latencies = [];

      for (let i = 0; i < scenario.insertCount; i++) {
        const vec = formatPgVector(embeddings.vectors[i]);
        const start = performance.now();
        await db.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
        latencies.push(performance.now() - start);
      }

      const totalTime = latencies.reduce((a, b) => a + b, 0);
      const qps = Math.round((scenario.insertCount / totalTime) * 1000);
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

      try { await db.close(); } catch { /* ignore */ }

      return {
        throughput: qps,
        recall: 'N/A',
        p50: parseFloat(p50),
        p99: parseFloat(p99),
        errors: 0,
        totalOps: scenario.insertCount,
        skipped: false
      };
    }

    // SEARCH scenario - measure recall and QPS
    // Phase 1: Insert all vectors (not measured)
    console.log('    Inserting vectors...');
    for (let i = 0; i < embeddings.vectors.length; i++) {
      const vec = formatPgVector(embeddings.vectors[i]);
      await db.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
    }

    // Phase 2: Warm-up queries (not measured)
    console.log('    Warming up...');
    for (let i = 0; i < scenario.warmupQueries; i++) {
      const queryVec = formatPgVector(queryVectors[i % queryVectors.length]);
      await db.query(`SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`, [queryVec, scenario.k]);
    }

    // Phase 3: Measured queries with recall tracking
    console.log('    Running measured queries...');
    const latencies = [];
    const approximateResults = [];

    for (let i = 0; i < scenario.queryCount; i++) {
      const queryVec = formatPgVector(queryVectors[i]);
      const start = performance.now();
      const result = await db.query(
        `SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`,
        [queryVec, scenario.k]
      );
      latencies.push(performance.now() - start);

      // Collect IDs for recall calculation
      approximateResults.push(result.rows.map(r => r.id));
    }

    // Calculate recall
    const { recall } = calculateRecall(approximateResults, groundTruth, scenario.k);

    // Calculate metrics
    const totalTime = latencies.reduce((a, b) => a + b, 0);
    const qps = Math.round((scenario.queryCount / totalTime) * 1000);
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

    try { await db.close(); } catch { /* ignore */ }

    return {
      throughput: qps,
      recall: (recall * 100).toFixed(1),  // as percentage
      p50: parseFloat(p50),
      p99: parseFloat(p99),
      errors: 0,
      totalOps: scenario.queryCount,
      skipped: false
    };
  } catch (error) {
    console.error('   PGlite vector benchmark failed:', error.message);
    return { throughput: 0, recall: 0, p50: 0, p99: 0, errors: 1, totalOps: 0, skipped: true };
  }
}

/**
 * PostgreSQL Server Vector Benchmark
 * Supports both INSERT and SEARCH scenarios
 */
async function benchmarkPostgreSQLVector(scenario, embeddings, queryVectors, groundTruth) {
  console.log('  🔷 Running PostgreSQL vector benchmark...');

  const pool = new Pool({
    ...POSTGRES_CONFIG,
    max: 20
  });

  try {
    // Test connection and check for pgvector
    await pool.query('SELECT 1');

    // Check if pgvector is available
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (e) {
      console.error('   pgvector extension not available. Use pgvector/pgvector:pg17 Docker image.');
      await pool.end();
      return { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 1, totalOps: 0, skipped: true };
    }

    // Setup schema
    await pool.query(`
      DROP TABLE IF EXISTS embeddings;
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY,
        vector vector(${scenario.dimension})
      )
    `);

    // INSERT scenario - measure insert speed
    if (scenario.type === 'INSERT') {
      console.log(`    Inserting ${scenario.insertCount} vectors (measured)...`);
      const latencies = [];

      for (let i = 0; i < scenario.insertCount; i++) {
        const vec = formatPgVector(embeddings.vectors[i]);
        const start = performance.now();
        await pool.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
        latencies.push(performance.now() - start);
      }

      const totalTime = latencies.reduce((a, b) => a + b, 0);
      const qps = Math.round((scenario.insertCount / totalTime) * 1000);
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

      await pool.query('DROP TABLE IF EXISTS embeddings');
      await pool.end();

      return {
        throughput: qps,
        recall: 'N/A',
        p50: parseFloat(p50),
        p99: parseFloat(p99),
        errors: 0,
        totalOps: scenario.insertCount,
        skipped: false
      };
    }

    // SEARCH scenario - Phase 1: Insert all vectors (not measured)
    console.log('    Inserting vectors...');
    for (let i = 0; i < embeddings.vectors.length; i++) {
      const vec = formatPgVector(embeddings.vectors[i]);
      await pool.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
    }

    // Phase 2: Warm-up queries (not measured)
    console.log('    Warming up...');
    for (let i = 0; i < scenario.warmupQueries; i++) {
      const queryVec = formatPgVector(queryVectors[i % queryVectors.length]);
      await pool.query(`SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`, [queryVec, scenario.k]);
    }

    // Phase 3: Measured queries with recall tracking
    console.log('    Running measured queries...');
    const latencies = [];
    const approximateResults = [];

    for (let i = 0; i < scenario.queryCount; i++) {
      const queryVec = formatPgVector(queryVectors[i]);
      const start = performance.now();
      const result = await pool.query(
        `SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`,
        [queryVec, scenario.k]
      );
      latencies.push(performance.now() - start);

      // Collect IDs for recall calculation
      approximateResults.push(result.rows.map(r => r.id));
    }

    // Calculate recall
    const { recall } = calculateRecall(approximateResults, groundTruth, scenario.k);

    // Calculate metrics
    const totalTime = latencies.reduce((a, b) => a + b, 0);
    const qps = Math.round((scenario.queryCount / totalTime) * 1000);
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

    // Cleanup
    await pool.query('DROP TABLE IF EXISTS embeddings');
    await pool.end();

    return {
      throughput: qps,
      recall: (recall * 100).toFixed(1),  // as percentage
      p50: parseFloat(p50),
      p99: parseFloat(p99),
      errors: 0,
      totalOps: scenario.queryCount,
      skipped: false
    };
  } catch (error) {
    console.error('   PostgreSQL vector benchmark skipped:', error.message);
    await pool.end().catch(() => {});
    return { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 0, totalOps: 0, skipped: true };
  }
}

/**
 * pgserve Vector Benchmark
 * Supports both INSERT and SEARCH scenarios
 */
async function benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, useRam = false) {
  const mode = useRam ? 'RAM' : 'disk';
  console.log(`  🚀 Running pgserve (${mode}) vector benchmark...`);

  let server;
  try {
    // Start pgserve (use different ports for vector benchmarks to avoid conflicts)
    const port = useRam ? 18435 : 18434;
    server = await startMultiTenantServer({
      port,
      logLevel: 'error',
      useRam
    });

    // Wait for server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pool = new Pool({
      host: 'localhost',
      port,
      database: 'vector_bench',
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

    // Enable pgvector extension
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (e) {
      console.error(`   pgvector extension not available in pgserve. Install pgvector files to ~/.pgserve/bin/<platform>/`);
      await pool.end();
      await server.stop();
      return { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 0, totalOps: 0, skipped: true, reason: 'pgvector not installed' };
    }

    // Setup schema
    await pool.query(`
      DROP TABLE IF EXISTS embeddings;
      CREATE TABLE embeddings (
        id INTEGER PRIMARY KEY,
        vector vector(${scenario.dimension})
      )
    `);

    // INSERT scenario - measure insert speed
    if (scenario.type === 'INSERT') {
      console.log(`    Inserting ${scenario.insertCount} vectors (measured)...`);
      const latencies = [];

      for (let i = 0; i < scenario.insertCount; i++) {
        const vec = formatPgVector(embeddings.vectors[i]);
        const start = performance.now();
        await pool.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
        latencies.push(performance.now() - start);
      }

      const totalTime = latencies.reduce((a, b) => a + b, 0);
      const qps = Math.round((scenario.insertCount / totalTime) * 1000);
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

      await pool.query('DROP TABLE IF EXISTS embeddings');
      await pool.end();
      await server.stop();

      return {
        throughput: qps,
        recall: 'N/A',
        p50: parseFloat(p50),
        p99: parseFloat(p99),
        errors: 0,
        totalOps: scenario.insertCount,
        skipped: false
      };
    }

    // SEARCH scenario - Phase 1: Insert all vectors (not measured)
    console.log('    Inserting vectors...');
    for (let i = 0; i < embeddings.vectors.length; i++) {
      const vec = formatPgVector(embeddings.vectors[i]);
      await pool.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
    }

    // Phase 2: Warm-up queries (not measured)
    console.log('    Warming up...');
    for (let i = 0; i < scenario.warmupQueries; i++) {
      const queryVec = formatPgVector(queryVectors[i % queryVectors.length]);
      await pool.query(`SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`, [queryVec, scenario.k]);
    }

    // Phase 3: Measured queries with recall tracking
    console.log('    Running measured queries...');
    const latencies = [];
    const approximateResults = [];

    for (let i = 0; i < scenario.queryCount; i++) {
      const queryVec = formatPgVector(queryVectors[i]);
      const start = performance.now();
      const result = await pool.query(
        `SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2`,
        [queryVec, scenario.k]
      );
      latencies.push(performance.now() - start);

      // Collect IDs for recall calculation
      approximateResults.push(result.rows.map(r => r.id));
    }

    // Calculate recall
    const { recall } = calculateRecall(approximateResults, groundTruth, scenario.k);

    // Calculate metrics
    const totalTime = latencies.reduce((a, b) => a + b, 0);
    const qps = Math.round((scenario.queryCount / totalTime) * 1000);
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

    // Cleanup
    await pool.query('DROP TABLE IF EXISTS embeddings');
    await pool.end();
    await server.stop();

    return {
      throughput: qps,
      recall: (recall * 100).toFixed(1),  // as percentage
      p50: parseFloat(p50),
      p99: parseFloat(p99),
      errors: 0,
      totalOps: scenario.queryCount,
      skipped: false
    };
  } catch (error) {
    console.error(`   pgserve (${mode}) vector benchmark failed:`, error.message);
    if (server) {
      try { await server.stop(); } catch { /* ignore */ }
    }
    return { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 0, totalOps: 0, skipped: true, reason: error.message };
  }
}

/**
 * Generate comparison report
 */
function generateReport(results, vectorResults = []) {
  const report = {
    timestamp: new Date().toISOString(),
    scenarios: results,
    vectorScenarios: vectorResults
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

  // Vector benchmark results (with Recall@k)
  if (vectorResults && vectorResults.length > 0) {
    md += '---\n\n';
    md += '## Vector Benchmarks (pgvector) - Recall@k Methodology\n\n';
    md += '*Following industry-standard ANN-Benchmarks methodology: comparing approximate results to brute-force ground truth.*\n\n';

    for (const scenario of vectorResults) {
      md += `### ${scenario.name}\n\n`;
      md += `${scenario.description}\n\n`;

      const { pglite, postgres, pgserve, pgserveRam, k } = scenario;

      md += '```\n';
      md += '┌─────────────────┬──────────┬──────────┬──────────┬─────────────┐\n';
      md += '│ Metric          │ PGlite   │ PostgreSQL│ pgserve  │ pgserve RAM │\n';
      md += '├─────────────────┼──────────┼──────────┼──────────┼─────────────┤\n';

      const pad = (s, n) => String(s).padEnd(n);
      const val = (r, key) => r.skipped ? 'N/A' : r[key];
      const recallVal = (r) => r.skipped ? 'N/A' : `${r.recall}%`;

      md += `│ Recall@${String(k || 10).padEnd(8)}│ ${pad(recallVal(pglite), 8)} │ ${pad(recallVal(postgres), 9)} │ ${pad(recallVal(pgserve), 8)} │ ${pad(recallVal(pgserveRam), 11)} │\n`;
      md += `│ Throughput (qps)│ ${pad(val(pglite, 'throughput'), 8)} │ ${pad(val(postgres, 'throughput'), 9)} │ ${pad(val(pgserve, 'throughput'), 8)} │ ${pad(val(pgserveRam, 'throughput'), 11)} │\n`;
      md += `│ P50 latency (ms)│ ${pad(val(pglite, 'p50'), 8)} │ ${pad(val(postgres, 'p50'), 9)} │ ${pad(val(pgserve, 'p50'), 8)} │ ${pad(val(pgserveRam, 'p50'), 11)} │\n`;
      md += `│ P99 latency (ms)│ ${pad(val(pglite, 'p99'), 8)} │ ${pad(val(postgres, 'p99'), 9)} │ ${pad(val(pgserve, 'p99'), 8)} │ ${pad(val(pgserveRam, 'p99'), 11)} │\n`;
      md += `│ Errors          │ ${pad(val(pglite, 'errors'), 8)} │ ${pad(val(postgres, 'errors'), 9)} │ ${pad(val(pgserve, 'errors'), 8)} │ ${pad(val(pgserveRam, 'errors'), 11)} │\n`;
      md += '└─────────────────┴──────────┴──────────┴──────────┴─────────────┘\n';
      md += '```\n\n';

      // Find winner among non-skipped (considering both recall and throughput)
      const candidates = {};
      if (!pglite.skipped) candidates.pglite = { recall: parseFloat(pglite.recall), qps: pglite.throughput };
      if (!postgres.skipped) candidates.postgres = { recall: parseFloat(postgres.recall), qps: postgres.throughput };
      if (!pgserve.skipped) candidates.pgserve = { recall: parseFloat(pgserve.recall), qps: pgserve.throughput };
      if (pgserveRam && !pgserveRam.skipped) candidates.pgserveRam = { recall: parseFloat(pgserveRam.recall), qps: pgserveRam.throughput };

      if (Object.keys(candidates).length > 0) {
        const nameMap = { pglite: 'PGlite', postgres: 'PostgreSQL', pgserve: 'pgserve', pgserveRam: 'pgserve RAM' };
        // Winner = highest QPS among those with 100% recall, otherwise highest recall
        const perfect = Object.entries(candidates).filter(([, v]) => v.recall === 100);
        let winnerKey;
        if (perfect.length > 0) {
          winnerKey = perfect.reduce((a, b) => a[1].qps > b[1].qps ? a : b)[0];
          md += `**${nameMap[winnerKey]} wins** (100% recall @ ${candidates[winnerKey].qps} qps)\n\n`;
        } else {
          winnerKey = Object.entries(candidates).reduce((a, b) => a[1].recall > b[1].recall ? a : b)[0];
          md += `**${nameMap[winnerKey]} wins** (${candidates[winnerKey].recall}% recall @ ${candidates[winnerKey].qps} qps)\n\n`;
        }
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
  // Parse CLI args
  const args = process.argv.slice(2);
  const includeVector = args.includes('--include-vector') || args.includes('--vector');
  const vectorOnly = args.includes('--vector-only');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
pgserve Benchmark Suite

Usage:
  bun tests/benchmarks/runner.js [options]

Options:
  --include-vector   Include vector (pgvector) benchmarks
  --vector-only      Run only vector benchmarks
  --help, -h         Show this help

Vector benchmarks require:
  - PGLite: Built-in pgvector support
  - PostgreSQL: Docker image pgvector/pgvector:pg17
  - pgserve: Not yet supported (marked as skipped)
`);
    process.exit(0);
  }

  // Print banner
  banner();
  if (includeVector || vectorOnly) {
    console.log(`${C.dim}  + Vector benchmarks (pgvector) enabled${C.reset}\n`);
  }

  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const results = [];
  const vectorResults = [];

  // Check if RAM mode is available (Linux only with /dev/shm)
  const canUseRam = os.platform() === 'linux' && fs.existsSync('/dev/shm');
  if (canUseRam) {
    console.log(`${C.green}💾 RAM mode available (/dev/shm detected)${C.reset}\n`);
  } else {
    console.log(`${C.yellow}⚠️  RAM mode not available (Linux /dev/shm required)${C.reset}\n`);
  }

  // Run CRUD benchmarks (unless --vector-only)
  if (!vectorOnly) {
    for (const scenario of scenarios) {
      section(scenario.name, scenario.description);

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

      // Scenario results summary
      console.log(`\n  ${C.bold}Results:${C.reset}`);
      console.log(`  ${C.dim}──────────────────────────────────────────${C.reset}`);
      console.log(`  ${C.yellow}🔸${C.reset} SQLite:        ${C.bold}${sqlite.throughput}${C.reset} qps, P50=${sqlite.p50}ms, P99=${sqlite.p99}ms`);
      console.log(`  ${C.blue}🔹${C.reset} PGlite:        ${C.bold}${pglite.throughput}${C.reset} qps, P50=${pglite.p50}ms, P99=${pglite.p99}ms`);
      console.log(`  ${C.cyan}🔷${C.reset} PostgreSQL:    ${postgres.skipped ? `${C.dim}SKIPPED${C.reset}` : `${C.bold}${postgres.throughput}${C.reset} qps, P50=${postgres.p50}ms, P99=${postgres.p99}ms`}`);
      console.log(`  ${C.green}🚀${C.reset} pgserve:       ${C.bold}${pgserve.throughput}${C.reset} qps, P50=${pgserve.p50}ms, P99=${pgserve.p99}ms`);
      if (canUseRam) {
        console.log(`  ${C.magenta}⚡${C.reset} pgserve (RAM): ${C.bold}${pgserveRam.throughput}${C.reset} qps, P50=${pgserveRam.p50}ms, P99=${pgserveRam.p99}ms`);
      }
    }
  }

  // Run vector benchmarks (if --include-vector or --vector-only)
  if (includeVector || vectorOnly) {
    console.log(`\n${C.cyan}${C.bold}
╔════════════════════════════════════════════════════════════════╗
║  Vector Benchmarks (pgvector) - Recall@k Methodology          ║
╚════════════════════════════════════════════════════════════════╝${C.reset}\n`);

    // Load or generate embeddings
    console.log(`${C.dim}📦 Loading embeddings...${C.reset}`);
    const dimension = 1536;
    const corpusSize = 10000;  // 10k vectors (~60MB) to exceed buffer cache and show RAM vs disk difference

    // Ensure embeddings file exists
    getEmbeddingsPath(corpusSize, dimension);
    const embeddings = loadEmbeddings(`embeddings-${corpusSize}-${dimension}.json`);
    const queryVectors = generateQueryVectors(100, dimension);
    console.log(`${C.dim}   Loaded ${embeddings.vectors.length} corpus vectors, ${queryVectors.length} query vectors${C.reset}\n`);

    for (const scenario of vectorScenarios) {
      section(`Vector: ${scenario.name}`, scenario.description);

      let groundTruth = null;

      // Only compute ground truth for SEARCH scenarios
      if (scenario.type === 'SEARCH') {
        console.log(`${C.dim}  📐 Computing ground truth (brute-force k=${scenario.k})...${C.reset}`);
        groundTruth = getGroundTruth(
          embeddings.vectors,
          queryVectors.slice(0, scenario.queryCount),
          scenario.k,
          `corpus-${corpusSize}-dim-${dimension}-queries-${scenario.queryCount}`
        );
      }

      // Run benchmarks
      const pglite = await benchmarkPGliteVector(scenario, embeddings, queryVectors, groundTruth);
      const postgres = await benchmarkPostgreSQLVector(scenario, embeddings, queryVectors, groundTruth);
      const pgserve = await benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, false);
      const pgserveRam = canUseRam
        ? await benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, true)
        : { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 0, totalOps: 0, skipped: true };

      vectorResults.push({
        name: scenario.name,
        description: scenario.description,
        type: scenario.type,
        k: scenario.k,
        pglite,
        postgres,
        pgserve,
        pgserveRam
      });

      // Vector scenario results summary
      const isInsert = scenario.type === 'INSERT';
      console.log(`\n  ${C.bold}Results (${isInsert ? 'INSERT QPS' : `Recall@${scenario.k} + QPS`}):${C.reset}`);
      console.log(`  ${C.dim}──────────────────────────────────────────────────────${C.reset}`);
      const formatResult = (r, icon, color, name) => {
        if (r.skipped) return `  ${color}${icon}${C.reset} ${name.padEnd(14)} ${C.dim}SKIPPED${r.reason ? ` (${r.reason})` : ''}${C.reset}`;
        if (isInsert) {
          return `  ${color}${icon}${C.reset} ${name.padEnd(14)} ${C.bold}${r.throughput}${C.reset} inserts/sec, P50=${r.p50}ms, P99=${r.p99}ms`;
        }
        return `  ${color}${icon}${C.reset} ${name.padEnd(14)} Recall: ${C.bold}${r.recall}%${C.reset}, ${C.bold}${r.throughput}${C.reset} qps, P50=${r.p50}ms`;
      };
      console.log(formatResult(pglite, '🔹', C.blue, 'PGlite:'));
      console.log(formatResult(postgres, '🔷', C.cyan, 'PostgreSQL:'));
      console.log(formatResult(pgserve, '🚀', C.green, 'pgserve:'));
      if (canUseRam) {
        console.log(formatResult(pgserveRam, '⚡', C.magenta, 'pgserve (RAM):'));
      }
    }
  }

  // Save detailed JSON report
  generateReport(results, vectorResults);

  // Print final results table with scores
  printFinalResults(results, vectorResults, canUseRam);

  console.log(`${C.cyan}${C.bold}╔════════════════════════════════════════════════════════════════╗
║  Benchmarks Complete!                                         ║
║                                                                ║
║  Try it yourself:  npx pgserve                                ║
╚════════════════════════════════════════════════════════════════╝${C.reset}
`);
}

main().catch(console.error);
