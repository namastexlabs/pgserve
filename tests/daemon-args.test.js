/**
 * Integration tests for `pgserve daemon` argv parsing.
 *
 * `parseDaemonArgs` lives inside `bin/postgres-server.js` (the script
 * entry point) and isn't exported, so we exercise it via subprocess
 * invocations of the wrapper. Each test runs in <100ms — they only ask
 * the daemon to print help or reject an invalid argument; no real
 * postgres backend is started.
 *
 * Background: every recent CLI-flag mismatch between callers and
 * `pgserve daemon` exited the daemon child with code 1 immediately,
 * surfacing upstream as the unhelpful "pgserve v2 daemon exited before
 * binding …" error. These tests pin the daemon's accepted flag set
 * explicitly so the next mismatch fails CI here, not at runtime.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PGSERVE_BIN = join(REPO_ROOT, 'bin', 'pgserve-wrapper.cjs');

function runDaemon(args, timeoutMs = 3000) {
  return spawnSync('node', [PGSERVE_BIN, 'daemon', ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('pgserve daemon — argv parser', () => {
  test('--help lists every flag the daemon accepts', () => {
    const result = runDaemon(['--help']);
    expect(result.status).toBe(0);
    const help = result.stdout;
    // Every flag the parser accepts must appear in --help so callers
    // (and the next operator running `pgserve daemon --help`) discover them.
    expect(help).toContain('--data');
    expect(help).toContain('--ram');
    expect(help).toContain('--log');
    expect(help).toContain('--no-provision');
    expect(help).toContain('--listen');
    expect(help).toContain('--pgvector');
    expect(help).toContain('--max-connections');
    expect(help).toContain('--help');
  });

  test('--max-connections accepts a positive integer (no "Unknown option" error)', () => {
    // Use a bogus --data path so the daemon never actually starts postgres
    // — the parser runs, accepts --max-connections, then PgserveDaemon
    // tries to start and fails on the missing/invalid data dir. We only
    // care that the parser doesn't reject the flag.
    const result = runDaemon(['--data', '/nonexistent/pgserve-test-dir', '--max-connections', '5000', '--log', 'error']);
    // The daemon may exit non-zero because the data dir is invalid, but
    // it MUST NOT exit with "Unknown daemon option" — that's the
    // pre-fix behavior we're guarding against.
    const stderr = result.stderr ?? '';
    expect(stderr).not.toContain('Unknown daemon option: --max-connections');
  });

  test('--max-connections rejects non-numeric values with a clear error', () => {
    const result = runDaemon(['--max-connections', 'abc']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--max-connections: expected a positive integer');
  });

  test('--max-connections rejects zero / negative values', () => {
    const zero = runDaemon(['--max-connections', '0']);
    expect(zero.status).toBe(1);
    expect(zero.stderr).toContain('--max-connections: expected a positive integer');

    const negative = runDaemon(['--max-connections', '-50']);
    expect(negative.status).toBe(1);
    expect(negative.stderr).toContain('--max-connections: expected a positive integer');
  });

  test('unknown flags still exit 1 with the documented "Unknown daemon option" error', () => {
    // Sanity: the parser hasn't become permissive. Genuinely unknown
    // flags must still error out so callers learn about the mismatch.
    const result = runDaemon(['--definitely-not-a-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown daemon option: --definitely-not-a-flag');
  });
});
