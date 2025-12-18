#!/usr/bin/env bun

/**
 * Vector Embedding Generator for Benchmarks
 *
 * Generates pre-computed random unit vectors for consistent benchmarking.
 * Excludes embedding API latency from database performance measurements.
 *
 * Usage:
 *   bun tests/benchmarks/vector-generator.js [--count=10000] [--dim=1536]
 *   bun tests/benchmarks/vector-generator.js --all  # Generate all standard fixtures
 */

import fs from 'fs';
import path from 'path';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

/**
 * Generate a random unit vector (normalized L2)
 * @param {number} dimension - Vector dimension
 * @returns {number[]} Normalized vector
 */
function generateUnitVector(dimension) {
  // Generate random values from normal distribution (Box-Muller transform)
  const vector = [];
  for (let i = 0; i < dimension; i++) {
    // Use uniform random and transform to approximate normal
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    vector.push(z);
  }

  // Normalize to unit length (L2 norm = 1)
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / norm);
}

/**
 * Generate embeddings with metadata
 * @param {number} count - Number of embeddings
 * @param {number} dimension - Vector dimension
 * @param {number} seed - Random seed for reproducibility (resets Math.random)
 * @returns {{ vectors: number[][], metadata: object[] }}
 */
function generateEmbeddings(count, dimension, seed = 42) {
  // Simple seeded random (LCG)
  let state = seed;
  const seededRandom = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  // Override Math.random temporarily
  const originalRandom = Math.random;
  Math.random = seededRandom;

  const vectors = [];
  const metadata = [];

  const categories = ['technology', 'science', 'business', 'health', 'sports', 'entertainment'];
  const tenants = ['tenant_a', 'tenant_b', 'tenant_c', 'tenant_d', 'tenant_e'];

  console.log(`Generating ${count.toLocaleString()} vectors of dimension ${dimension}...`);
  const startTime = performance.now();

  for (let i = 0; i < count; i++) {
    vectors.push(generateUnitVector(dimension));
    metadata.push({
      id: i + 1,
      category: categories[Math.floor(Math.random() * categories.length)],
      tenant_id: tenants[Math.floor(Math.random() * tenants.length)],
      timestamp: new Date(Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000)).toISOString(),
      score: Math.random()
    });

    // Progress indicator
    if ((i + 1) % 1000 === 0) {
      process.stdout.write(`\r  Generated ${(i + 1).toLocaleString()} / ${count.toLocaleString()} vectors`);
    }
  }

  // Restore original Math.random
  Math.random = originalRandom;

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`\n  Completed in ${elapsed}s`);

  return { vectors, metadata };
}

/**
 * Save embeddings to JSON file
 * @param {string} filename - Output filename
 * @param {{ vectors: number[][], metadata: object[] }} data - Embeddings data
 */
function saveEmbeddings(filename, data) {
  const filepath = path.join(FIXTURES_DIR, filename);

  // Ensure fixtures directory exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // Save with minimal formatting for smaller files
  const json = JSON.stringify(data);
  fs.writeFileSync(filepath, json);

  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`  Saved to ${filepath} (${sizeMB} MB)`);

  return filepath;
}

/**
 * Load embeddings from JSON file
 * @param {string} filename - Input filename
 * @returns {{ vectors: number[][], metadata: object[] }}
 */
export function loadEmbeddings(filename) {
  const filepath = path.join(FIXTURES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Embeddings file not found: ${filepath}. Run: bun tests/benchmarks/vector-generator.js --all`);
  }

  const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  console.log(`Loaded ${data.vectors.length.toLocaleString()} vectors from ${filename}`);
  return data;
}

/**
 * Get embeddings file path (generates if missing)
 * @param {number} count - Number of embeddings
 * @param {number} dimension - Vector dimension
 * @returns {string} Path to embeddings file
 */
export function getEmbeddingsPath(count, dimension) {
  const filename = `embeddings-${count}-${dimension}.json`;
  const filepath = path.join(FIXTURES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    console.log(`\nGenerating missing embeddings file: ${filename}`);
    const data = generateEmbeddings(count, dimension);
    saveEmbeddings(filename, data);
  }

  return filepath;
}

/**
 * Generate query vectors (separate from corpus)
 * @param {number} count - Number of query vectors
 * @param {number} dimension - Vector dimension
 * @returns {number[][]} Query vectors
 */
export function generateQueryVectors(count, dimension, seed = 12345) {
  const data = generateEmbeddings(count, dimension, seed);
  return data.vectors;
}

/**
 * Format vector for PostgreSQL pgvector
 * @param {number[]} vector - Vector array
 * @returns {string} PostgreSQL vector literal
 */
export function formatPgVector(vector) {
  return `[${vector.join(',')}]`;
}

// ============================================================================
// RECALL MEASUREMENT (Industry-standard methodology)
// Based on: ANN-Benchmarks, Qdrant, VectorDBBench
// ============================================================================

/**
 * Compute L2 (Euclidean) distance squared between two vectors
 * We use squared distance for efficiency (avoids sqrt, maintains ordering)
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Squared L2 distance
 */
export function l2DistanceSquared(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

/**
 * Compute ground truth (exact k-NN via brute force)
 * This is the gold standard that approximate results are compared against.
 *
 * @param {number[][]} corpus - All vectors in the database
 * @param {number[][]} queries - Query vectors
 * @param {number} k - Number of nearest neighbors
 * @returns {number[][]} Ground truth: array of k neighbor IDs for each query
 */
export function computeGroundTruth(corpus, queries, k) {
  console.log(`  Computing ground truth (brute-force k=${k} for ${queries.length} queries)...`);
  const startTime = performance.now();

  const groundTruth = [];

  for (let q = 0; q < queries.length; q++) {
    const query = queries[q];

    // Compute distance to all corpus vectors
    const distances = [];
    for (let i = 0; i < corpus.length; i++) {
      distances.push({
        id: i + 1, // 1-indexed to match database IDs
        distance: l2DistanceSquared(query, corpus[i])
      });
    }

    // Sort by distance and take top-k
    distances.sort((a, b) => a.distance - b.distance);
    groundTruth.push(distances.slice(0, k).map(d => d.id));

    // Progress
    if ((q + 1) % 10 === 0 || q === queries.length - 1) {
      process.stdout.write(`\r  Ground truth: ${q + 1}/${queries.length} queries`);
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`\n  Ground truth computed in ${elapsed}s`);

  return groundTruth;
}

/**
 * Calculate Recall@k
 * Recall = (# of ground truth neighbors found) / k
 *
 * @param {number[][]} approximateResults - IDs returned by approximate search
 * @param {number[][]} groundTruth - IDs from exact brute-force search
 * @param {number} k - Number of neighbors (for normalization)
 * @returns {{ recall: number, perQuery: number[] }} Average recall and per-query recalls
 */
export function calculateRecall(approximateResults, groundTruth, k) {
  if (approximateResults.length !== groundTruth.length) {
    throw new Error(`Result count mismatch: ${approximateResults.length} vs ${groundTruth.length}`);
  }

  const perQuery = [];
  let totalRecall = 0;

  for (let i = 0; i < approximateResults.length; i++) {
    const approxSet = new Set(approximateResults[i]);
    const truthSet = groundTruth[i];

    // Count how many ground truth neighbors were found
    let found = 0;
    for (const truthId of truthSet) {
      if (approxSet.has(truthId)) {
        found++;
      }
    }

    const queryRecall = found / k;
    perQuery.push(queryRecall);
    totalRecall += queryRecall;
  }

  return {
    recall: totalRecall / approximateResults.length,
    perQuery
  };
}

/**
 * Get or compute ground truth for a dataset
 * Caches the result to avoid recomputation
 *
 * @param {number[][]} corpus - Corpus vectors
 * @param {number[][]} queries - Query vectors
 * @param {number} k - Number of neighbors
 * @param {string} cacheKey - Unique key for caching
 * @returns {number[][]} Ground truth neighbor IDs
 */
const groundTruthCache = new Map();

export function getGroundTruth(corpus, queries, k, cacheKey) {
  const fullKey = `${cacheKey}-k${k}`;

  if (groundTruthCache.has(fullKey)) {
    console.log(`  Using cached ground truth for ${fullKey}`);
    return groundTruthCache.get(fullKey);
  }

  const groundTruth = computeGroundTruth(corpus, queries, k);
  groundTruthCache.set(fullKey, groundTruth);
  return groundTruth;
}

// Standard fixture configurations
const STANDARD_FIXTURES = [
  { count: 1000, dimension: 384, desc: 'Small corpus, small model (all-MiniLM)' },
  { count: 1000, dimension: 1536, desc: 'Small corpus, OpenAI embeddings' },
  { count: 10000, dimension: 384, desc: 'Medium corpus, small model' },
  { count: 10000, dimension: 1536, desc: 'Medium corpus, OpenAI embeddings' },
];

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Vector Embedding Generator for Benchmarks

Usage:
  bun tests/benchmarks/vector-generator.js [options]

Options:
  --all              Generate all standard fixtures
  --count=N          Number of embeddings (default: 10000)
  --dim=N            Vector dimension (default: 1536)
  --help, -h         Show this help

Standard Fixtures (--all):
${STANDARD_FIXTURES.map(f => `  - ${f.count} x ${f.dimension}-dim: ${f.desc}`).join('\n')}

Examples:
  bun tests/benchmarks/vector-generator.js --all
  bun tests/benchmarks/vector-generator.js --count=5000 --dim=768
`);
    process.exit(0);
  }

  if (args.includes('--all')) {
    console.log('\n=== Generating All Standard Fixtures ===\n');

    for (const { count, dimension, desc } of STANDARD_FIXTURES) {
      console.log(`\n[${count} x ${dimension}-dim] ${desc}`);
      const data = generateEmbeddings(count, dimension);
      saveEmbeddings(`embeddings-${count}-${dimension}.json`, data);
    }

    console.log('\n✓ All fixtures generated successfully\n');
  } else {
    // Parse individual options
    let count = 10000;
    let dimension = 1536;

    for (const arg of args) {
      if (arg.startsWith('--count=')) {
        count = parseInt(arg.split('=')[1], 10);
      } else if (arg.startsWith('--dim=')) {
        dimension = parseInt(arg.split('=')[1], 10);
      }
    }

    console.log(`\n=== Generating Embeddings ===\n`);
    console.log(`Count: ${count.toLocaleString()}`);
    console.log(`Dimension: ${dimension}`);

    const data = generateEmbeddings(count, dimension);
    saveEmbeddings(`embeddings-${count}-${dimension}.json`, data);

    console.log('\n✓ Done\n');
  }
}
