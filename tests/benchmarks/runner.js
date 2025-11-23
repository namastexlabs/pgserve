#!/usr/bin/env node

/**
 * Benchmark Runner
 * Compares SQLite, PGlite, and PostgreSQL performance
 */

import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { getOrStart } from '../../src/index.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Global error handlers (suppress expected PGlite WASM ExitStatus errors)
process.on('unhandledRejection', (reason, promise) => {
  // ExitStatus errors are expected from PGlite WASM cleanup - ignore them
  if (reason && reason.name === 'ExitStatus') {
    return;
  }
  console.error('❌ Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  // ExitStatus errors are expected from PGlite WASM cleanup - ignore them
  if (error && error.name === 'ExitStatus') {
    return;
  }
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

const RESULTS_DIR = new URL('./results', import.meta.url).pathname;

/**
 * Benchmark scenario configuration
 */
const scenarios = [
  {
    name: 'Concurrent Writes (10 agents)',
    description: 'Simulates Hive agent sessions writing simultaneously',
    operations: [
      { type: 'INSERT', count: 100, concurrent: 10 }
    ]
  },
  {
    name: 'Mixed Workload (messages)',
    description: 'Simulates Evolution API message operations',
    operations: [
      { type: 'INSERT', count: 500 },
      { type: 'SELECT', count: 2000 },
      { type: 'UPDATE', count: 250 }
    ]
  },
  {
    name: 'Write Lock Contention',
    description: 'Stress test for lock handling',
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
    }
  }

  metrics.end();
  db.close();

  return metrics.getReport();
}

/**
 * PGlite Benchmark
 */
async function benchmarkPGlite(scenario) {
  console.log('  🔹 Running PGlite benchmark...');

  const dataDir = path.join(RESULTS_DIR, 'pglite-bench');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true });
  }

  const instance = await getOrStart({
    dataDir,
    port: 12999,
    autoPort: true,
    logLevel: 'error'
  });

  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Setup schema using PGlite directly
  const db = new PGlite(dataDir);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
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
                await db.query(
                  'INSERT INTO messages (content, timestamp) VALUES ($1, $2)',
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
    }
  }

  metrics.end();
  await db.close();

  // Stop instance
  if (!instance.existing) {
    await instance.stop();
  }

  return metrics.getReport();
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

  for (const scenario of results) {
    md += `## ${scenario.name}\n\n`;
    md += `${scenario.description}\n\n`;

    md += '```\n';
    md += '┌─────────────────┬──────────┬──────────┬──────────┐\n';
    md += '│ Database        │ SQLite   │ PGlite   │ Winner   │\n';
    md += '├─────────────────┼──────────┼──────────┼──────────┤\n';

    const sqlite = scenario.sqlite;
    const pglite = scenario.pglite;

    md += `│ Throughput      │ ${String(sqlite.throughput).padEnd(8)} │ ${String(pglite.throughput).padEnd(8)} │ ${pglite.throughput > sqlite.throughput ? 'PGlite' : 'SQLite'}   │\n`;
    md += `│ P50 latency     │ ${String(sqlite.p50) + 'ms'.padEnd(8)} │ ${String(pglite.p50) + 'ms'.padEnd(8)} │ ${pglite.p50 < sqlite.p50 ? 'PGlite' : 'SQLite'}   │\n`;
    md += `│ P99 latency     │ ${String(sqlite.p99) + 'ms'.padEnd(8)} │ ${String(pglite.p99) + 'ms'.padEnd(8)} │ ${pglite.p99 < sqlite.p99 ? 'PGlite' : 'SQLite'}   │\n`;
    md += `│ Errors          │ ${String(sqlite.errors).padEnd(8)} │ ${String(pglite.errors).padEnd(8)} │ ${pglite.errors < sqlite.errors ? 'PGlite' : 'SQLite'}   │\n`;
    md += `│ Lock timeouts   │ ${String(sqlite.lockTimeouts).padEnd(8)} │ ${String(pglite.lockTimeouts).padEnd(8)} │ ${pglite.lockTimeouts < sqlite.lockTimeouts ? 'PGlite' : 'SQLite'}   │\n`;
    md += '└─────────────────┴──────────┴──────────┴──────────┘\n';
    md += '```\n\n';

    if (pglite.throughput > sqlite.throughput) {
      const improvement = ((pglite.throughput / sqlite.throughput - 1) * 100).toFixed(1);
      md += `💡 **PGlite is ${improvement}% faster than SQLite for this workload**\n\n`;
    }
  }

  const mdPath = path.join(RESULTS_DIR, 'benchmark-results.md');
  fs.writeFileSync(mdPath, md);

  console.log(`\n✅ Results saved to:`);
  console.log(`   JSON: ${jsonPath}`);
  console.log(`   Markdown: ${mdPath}\n`);

  return report;
}

/**
 * Main runner
 */
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  PGlite Embedded Server - Benchmark Suite                    ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n📊 Scenario: ${scenario.name}`);
    console.log(`   ${scenario.description}\n`);

    const sqlite = await benchmarkSQLite(scenario);
    const pglite = await benchmarkPGlite(scenario);

    results.push({
      name: scenario.name,
      description: scenario.description,
      sqlite,
      pglite
    });

    console.log(`\n   SQLite:  ${sqlite.throughput} qps, P50=${sqlite.p50}ms, errors=${sqlite.errors}`);
    console.log(`   PGlite:  ${pglite.throughput} qps, P50=${pglite.p50}ms, errors=${pglite.errors}`);
  }

  console.log('\n📄 Generating report...\n');
  const report = generateReport(results);

  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ Benchmarks Complete!                                      ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
