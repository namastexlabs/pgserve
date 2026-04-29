#!/usr/bin/env bun

/**
 * Benchmark Runner
 * Compares SQLite, PostgreSQL, and pgserve performance
 *
 * 100% Bun-native: Uses bun:sqlite instead of better-sqlite3
 */

import { Database } from 'bun:sqlite';
import { startMultiTenantServer } from '../../src/index.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pg from 'pg';
import { loadEmbeddings, generateQueryVectors, formatPgVector, getEmbeddingsPath, getGroundTruth, calculateRecall } from './vector-generator.js';

const { Pool } = pg;
const LEGACY_PGSERVE_VERSION = '1.2.0';
const LEGACY_PGSERVE_SPEC = `pgserve@${LEGACY_PGSERVE_VERSION}`;
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

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
║  Comparing: SQLite │ PostgreSQL │ pgserve 1.2.0 │ pgserve v2    ║
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
  // filled is clamped to [0, width], so (width - filled) is always non-negative
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  const empty = width - filled;
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
    postgres: { name: 'PostgreSQL', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0, skipped: false },
    pgserveV1: { name: 'pgserve 1.2.0', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
    pgserve: { name: 'pgserve v2', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
    pgserveRam: { name: 'pgserve v2 RAM', crudQps: 0, vecQps: 0, vecRecall: 0, p50: 0, p99: 0, errors: 0, count: 0, vecCount: 0, recallCount: 0 },
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
  const engineOrder = ['sqlite', 'postgres', 'pgserveV1', 'pgserve'];
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

// Global error handlers (suppress expected PostgreSQL WASM ExitStatus errors)
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

function skippedCrud(reason, errors = 1) {
  return { throughput: 0, p50: 0, p99: 0, errors, lockTimeouts: 0, totalOps: 0, skipped: true, reason };
}

function skippedVector(reason, errors = 1) {
  return { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors, totalOps: 0, skipped: true, reason };
}

async function openPgPool({ port, database, max = 20, timeoutMs = 30_000 }) {
  const pool = new Pool({
    host: '127.0.0.1',
    port,
    database,
    user: 'postgres',
    password: 'postgres',
    max,
    connectionTimeoutMillis: 1000
  });

  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  await pool.end().catch(() => {});
  throw lastError || new Error(`PostgreSQL did not become ready on port ${port}`);
}

async function runCrudScenarioOnPool(pool, scenario) {
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
  await pool.query('DROP TABLE IF EXISTS bench_messages');
  return metrics.getReport();
}

async function runVectorScenarioOnPool(pool, scenario, embeddings, queryVectors, groundTruth) {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  await pool.query(`
    DROP TABLE IF EXISTS embeddings;
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY,
      vector vector(${scenario.dimension})
    )
  `);

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

  console.log('    Inserting vectors...');
  for (let i = 0; i < embeddings.vectors.length; i++) {
    const vec = formatPgVector(embeddings.vectors[i]);
    await pool.query('INSERT INTO embeddings (id, vector) VALUES ($1, $2::vector)', [i + 1, vec]);
  }

  console.log('    Warming up...');
  for (let i = 0; i < scenario.warmupQueries; i++) {
    const queryVec = formatPgVector(queryVectors[i % queryVectors.length]);
    await pool.query('SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2', [queryVec, scenario.k]);
  }

  console.log('    Running measured queries...');
  const latencies = [];
  const approximateResults = [];

  for (let i = 0; i < scenario.queryCount; i++) {
    const queryVec = formatPgVector(queryVectors[i]);
    const start = performance.now();
    const result = await pool.query(
      'SELECT id FROM embeddings ORDER BY vector <-> $1::vector LIMIT $2',
      [queryVec, scenario.k]
    );
    latencies.push(performance.now() - start);
    approximateResults.push(result.rows.map(r => r.id));
  }

  const { recall } = calculateRecall(approximateResults, groundTruth, scenario.k);
  const totalTime = latencies.reduce((a, b) => a + b, 0);
  const qps = Math.round((scenario.queryCount / totalTime) * 1000);
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)]?.toFixed(1) || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)]?.toFixed(1) || 0;

  await pool.query('DROP TABLE IF EXISTS embeddings');

  return {
    throughput: qps,
    recall: (recall * 100).toFixed(1),
    p50: parseFloat(p50),
    p99: parseFloat(p99),
    errors: 0,
    totalOps: scenario.queryCount,
    skipped: false
  };
}

async function startLegacyPgserve({ port, enablePgvector = false }) {
  const dataDir = path.join(RESULTS_DIR, `pgserve-${LEGACY_PGSERVE_VERSION}-port-${port}`);
  fs.rmSync(dataDir, { recursive: true, force: true });

  const args = [
    '-y',
    LEGACY_PGSERVE_SPEC,
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    '--data',
    dataDir,
    '--log',
    'error',
    '--no-stats',
    '--no-cluster',
  ];
  if (enablePgvector) args.push('--pgvector');

  const tail = [];
  const child = spawn(NPX_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });

  const append = (chunk) => {
    tail.push(String(chunk));
    while (tail.join('').length > 4000) tail.shift();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    const pool = await openPgPool({ port, database: 'bench_test', timeoutMs: 60_000 });
    await pool.end();
  } catch (error) {
    await stopChildProcess(child);
    const output = tail.join('').trim();
    const detail = output ? `; output: ${output}` : '';
    throw new Error(`${LEGACY_PGSERVE_SPEC} failed to become ready: ${error.message}${detail}`);
  }

  return {
    async stop() {
      if (!exited) await stopChildProcess(child);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
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
 * PostgreSQL Server Benchmark (remote real PostgreSQL)
 */
async function benchmarkPostgreSQL(scenario) {
  console.log('  🔷 Running PostgreSQL Server benchmark...');

  let pool;
  try {
    pool = await openPgPool({ ...POSTGRES_CONFIG });
    return await runCrudScenarioOnPool(pool, scenario);
  } catch (error) {
    console.error('   PostgreSQL benchmark skipped:', error.message);
    return skippedCrud(error.message, 0);
  } finally {
    await pool?.end().catch(() => {});
  }
}

/**
 * pgserve 1.2.0 Benchmark (published npm package)
 */
async function benchmarkPgserveV1(scenario) {
  console.log(`  🧭 Running ${LEGACY_PGSERVE_SPEC} benchmark...`);

  let legacy;
  let pool;
  try {
    legacy = await startLegacyPgserve({ port: 18431 });
    pool = await openPgPool({ port: 18431, database: 'bench_test' });
    return await runCrudScenarioOnPool(pool, scenario);
  } catch (error) {
    console.error(`   ${LEGACY_PGSERVE_SPEC} benchmark skipped:`, error.message);
    return skippedCrud(error.message);
  } finally {
    await pool?.end().catch(() => {});
    await legacy?.stop().catch(() => {});
  }
}

/**
 * pgserve Benchmark (our solution - embedded PostgreSQL with TRUE concurrency)
 * @param {Object} scenario - Benchmark scenario
 * @param {boolean} useRam - Use /dev/shm RAM storage (Linux only)
 */
async function benchmarkPgserve(scenario, useRam = false) {
  const mode = useRam ? 'RAM' : 'disk';
  console.log(`  🚀 Running pgserve v2 (${mode}) benchmark...`);

  let server;
  let pool;
  try {
    // Start pgserve in memory mode (optionally with RAM storage)
    const port = useRam ? 18433 : 18432;
    server = await startMultiTenantServer({
      port,
      logLevel: 'error',
      useRam
    });

    pool = await openPgPool({ port, database: 'bench_test' });
    return await runCrudScenarioOnPool(pool, scenario);
  } catch (error) {
    console.error(`   pgserve v2 (${mode}) benchmark failed:`, error.message);
    return skippedCrud(error.message);
  } finally {
    await pool?.end().catch(() => {});
    await server?.stop().catch(() => {});
  }
}

// ============================================================================
// VECTOR BENCHMARKS (pgvector)
// ============================================================================

/**
 * PostgreSQL Server Vector Benchmark
 * Supports both INSERT and SEARCH scenarios
 */
async function benchmarkPostgreSQLVector(scenario, embeddings, queryVectors, groundTruth) {
  console.log('  🔷 Running PostgreSQL vector benchmark...');

  let pool;
  try {
    pool = await openPgPool({ ...POSTGRES_CONFIG });
    return await runVectorScenarioOnPool(pool, scenario, embeddings, queryVectors, groundTruth);
  } catch (error) {
    console.error('   PostgreSQL vector benchmark skipped:', error.message);
    return skippedVector(error.message, 0);
  } finally {
    await pool?.end().catch(() => {});
  }
}

/**
 * pgserve 1.2.0 Vector Benchmark (published npm package)
 */
async function benchmarkPgserveV1Vector(scenario, embeddings, queryVectors, groundTruth) {
  console.log(`  🧭 Running ${LEGACY_PGSERVE_SPEC} vector benchmark...`);

  let legacy;
  let pool;
  try {
    legacy = await startLegacyPgserve({ port: 18434, enablePgvector: true });
    pool = await openPgPool({ port: 18434, database: 'vector_bench' });
    return await runVectorScenarioOnPool(pool, scenario, embeddings, queryVectors, groundTruth);
  } catch (error) {
    console.error(`   ${LEGACY_PGSERVE_SPEC} vector benchmark skipped:`, error.message);
    return skippedVector(error.message);
  } finally {
    await pool?.end().catch(() => {});
    await legacy?.stop().catch(() => {});
  }
}

/**
 * pgserve Vector Benchmark
 * Supports both INSERT and SEARCH scenarios
 */
async function benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, useRam = false) {
  const mode = useRam ? 'RAM' : 'disk';
  console.log(`  🚀 Running pgserve v2 (${mode}) vector benchmark...`);

  let server;
  let pool;
  try {
    // Start pgserve (use different ports for vector benchmarks to avoid conflicts)
    const port = useRam ? 18436 : 18435;
    server = await startMultiTenantServer({
      port,
      logLevel: 'error',
      useRam,
      enablePgvector: true
    });

    pool = await openPgPool({ port, database: 'vector_bench' });
    return await runVectorScenarioOnPool(pool, scenario, embeddings, queryVectors, groundTruth);
  } catch (error) {
    console.error(`   pgserve v2 (${mode}) vector benchmark failed:`, error.message);
    return skippedVector(error.message, 0);
  } finally {
    await pool?.end().catch(() => {});
    await server?.stop().catch(() => {});
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

  const metricValue = (data, key) => {
    if (!data || data.skipped) return 'N/A';
    const value = data[key];
    return value === undefined || value === null ? 'N/A' : value;
  };
  const metricNumber = (data, key) => {
    if (!data || data.skipped) return null;
    const value = Number.parseFloat(data[key]);
    return Number.isFinite(value) ? value : null;
  };
  const winnerName = (rows, key, direction) => {
    let winner = null;
    for (const row of rows) {
      const value = metricNumber(row.data, key);
      if (value === null) continue;
      if (!winner || (direction === 'max' ? value > winner.value : value < winner.value)) {
        winner = { name: row.name, value };
      }
    }
    return winner?.name || 'N/A';
  };
  const pctDelta = (current, baseline) => {
    if (!current || !baseline || current.skipped || baseline.skipped || baseline.throughput <= 0) return null;
    return ((current.throughput / baseline.throughput - 1) * 100).toFixed(1);
  };
  const renderMetricTable = (rows, metrics) => {
    let table = `| Metric | ${rows.map(r => r.name).join(' | ')} | Winner |\n`;
    table += `| --- | ${rows.map(() => '---:').join(' | ')} | --- |\n`;
    for (const metric of metrics) {
      table += `| ${metric.label} | ${rows.map(r => metric.format(metricValue(r.data, metric.key))).join(' | ')} | ${winnerName(rows, metric.key, metric.direction)} |\n`;
    }
    return `${table}\n`;
  };
  const plain = (value) => String(value);
  const percent = (value) => value === 'N/A' ? value : `${value}%`;

  for (const scenario of results) {
    md += `## ${scenario.name}\n\n`;
    md += `${scenario.description}\n\n`;

    const rows = [
      { name: 'SQLite', data: scenario.sqlite },
      { name: 'PostgreSQL', data: scenario.postgres },
      { name: 'pgserve 1.2.0', data: scenario.pgserveV1 },
      { name: 'pgserve v2', data: scenario.pgserve },
    ];
    if (scenario.pgserveRam && !scenario.pgserveRam.skipped) {
      rows.push({ name: 'pgserve v2 RAM', data: scenario.pgserveRam });
    }

    md += renderMetricTable(rows, [
      { label: 'Throughput (qps)', key: 'throughput', direction: 'max', format: plain },
      { label: 'P50 latency (ms)', key: 'p50', direction: 'min', format: plain },
      { label: 'P99 latency (ms)', key: 'p99', direction: 'min', format: plain },
      { label: 'Errors', key: 'errors', direction: 'min', format: plain },
    ]);

    const delta = pctDelta(scenario.pgserve, scenario.pgserveV1);
    if (delta !== null) {
      md += `**pgserve v2 vs 1.2.0:** ${delta}% throughput delta.\n\n`;
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

      const rows = [
        { name: 'PostgreSQL', data: scenario.postgres },
        { name: 'pgserve 1.2.0', data: scenario.pgserveV1 },
        { name: 'pgserve v2', data: scenario.pgserve },
      ];
      if (scenario.pgserveRam && !scenario.pgserveRam.skipped) {
        rows.push({ name: 'pgserve v2 RAM', data: scenario.pgserveRam });
      }

      md += renderMetricTable(rows, [
        { label: `Recall@${scenario.k || 10}`, key: 'recall', direction: 'max', format: percent },
        { label: 'Throughput (qps)', key: 'throughput', direction: 'max', format: plain },
        { label: 'P50 latency (ms)', key: 'p50', direction: 'min', format: plain },
        { label: 'P99 latency (ms)', key: 'p99', direction: 'min', format: plain },
        { label: 'Errors', key: 'errors', direction: 'min', format: plain },
      ]);

      // Find winner among non-skipped (considering both recall and throughput)
      const candidates = {};
      if (!scenario.postgres.skipped) candidates.postgres = { recall: parseFloat(scenario.postgres.recall), qps: scenario.postgres.throughput };
      if (!scenario.pgserveV1.skipped) candidates.pgserveV1 = { recall: parseFloat(scenario.pgserveV1.recall), qps: scenario.pgserveV1.throughput };
      if (!scenario.pgserve.skipped) candidates.pgserve = { recall: parseFloat(scenario.pgserve.recall), qps: scenario.pgserve.throughput };
      if (scenario.pgserveRam && !scenario.pgserveRam.skipped) candidates.pgserveRam = { recall: parseFloat(scenario.pgserveRam.recall), qps: scenario.pgserveRam.throughput };

      if (Object.keys(candidates).length > 0) {
        const nameMap = { postgres: 'PostgreSQL', pgserveV1: 'pgserve 1.2.0', pgserve: 'pgserve v2', pgserveRam: 'pgserve v2 RAM' };
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

      const delta = pctDelta(scenario.pgserve, scenario.pgserveV1);
      if (delta !== null) {
        md += `**pgserve v2 vs 1.2.0:** ${delta}% throughput delta.\n\n`;
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
  - PostgreSQL: Built-in pgvector support
  - PostgreSQL: Docker image pgvector/pgvector:pg17
  - pgserve 1.2.0 and v2: --pgvector support
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
      const postgres = await benchmarkPostgreSQL(scenario);
      const pgserveV1 = await benchmarkPgserveV1(scenario);
      const pgserve = await benchmarkPgserve(scenario, false);  // disk mode
      const pgserveRam = canUseRam
        ? await benchmarkPgserve(scenario, true)  // RAM mode
        : { throughput: 0, p50: 0, p99: 0, errors: 0, lockTimeouts: 0, totalOps: 0, skipped: true };

      results.push({
        name: scenario.name,
        description: scenario.description,
        sqlite,
        postgres,
        pgserveV1,
        pgserve,
        pgserveRam
      });

      // Scenario results summary
      console.log(`\n  ${C.bold}Results:${C.reset}`);
      console.log(`  ${C.dim}──────────────────────────────────────────${C.reset}`);
      console.log(`  ${C.yellow}🔸${C.reset} SQLite:        ${C.bold}${sqlite.throughput}${C.reset} qps, P50=${sqlite.p50}ms, P99=${sqlite.p99}ms`);
      console.log(`  ${C.cyan}🔷${C.reset} PostgreSQL:    ${postgres.skipped ? `${C.dim}SKIPPED${C.reset}` : `${C.bold}${postgres.throughput}${C.reset} qps, P50=${postgres.p50}ms, P99=${postgres.p99}ms`}`);
      console.log(`  ${C.blue}🧭${C.reset} pgserve 1.2.0: ${pgserveV1.skipped ? `${C.dim}SKIPPED${C.reset}` : `${C.bold}${pgserveV1.throughput}${C.reset} qps, P50=${pgserveV1.p50}ms, P99=${pgserveV1.p99}ms`}`);
      console.log(`  ${C.green}🚀${C.reset} pgserve v2:    ${C.bold}${pgserve.throughput}${C.reset} qps, P50=${pgserve.p50}ms, P99=${pgserve.p99}ms`);
      if (canUseRam) {
        console.log(`  ${C.magenta}⚡${C.reset} pgserve v2 RAM: ${C.bold}${pgserveRam.throughput}${C.reset} qps, P50=${pgserveRam.p50}ms, P99=${pgserveRam.p99}ms`);
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
      const postgres = await benchmarkPostgreSQLVector(scenario, embeddings, queryVectors, groundTruth);
      const pgserveV1 = await benchmarkPgserveV1Vector(scenario, embeddings, queryVectors, groundTruth);
      const pgserve = await benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, false);
      const pgserveRam = canUseRam
        ? await benchmarkPgserveVector(scenario, embeddings, queryVectors, groundTruth, true)
        : { throughput: 0, recall: 'N/A', p50: 0, p99: 0, errors: 0, totalOps: 0, skipped: true };

      vectorResults.push({
        name: scenario.name,
        description: scenario.description,
        type: scenario.type,
        k: scenario.k,
        postgres,
        pgserveV1,
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
      console.log(formatResult(postgres, '🔷', C.cyan, 'PostgreSQL:'));
      console.log(formatResult(pgserveV1, '🧭', C.blue, 'pgserve 1.2.0:'));
      console.log(formatResult(pgserve, '🚀', C.green, 'pgserve v2:'));
      if (canUseRam) {
        console.log(formatResult(pgserveRam, '⚡', C.magenta, 'pgserve v2 RAM:'));
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
