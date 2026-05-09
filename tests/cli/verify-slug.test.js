/**
 * Tests for `pgserve verify --slug <slug>` (G3 D4b —
 * autopg-distribution-cutover-finalize).
 *
 * Drives `runVerify(argv, deps)` directly with a stubbed loadLockedRoots
 * so we don't need a running postmaster. The happy path (slug found ->
 * lockedRoots passed as options.trustList -> verifyBinary called with
 * the override) is exercised end-to-end by the integration test
 * tests/integration/verify-slug-rotation.test.sh, which spins up real
 * postgres + runs the wrapper.
 *
 * Coverage here:
 *   - --slug parse + value validation
 *   - --port parse + value validation
 *   - exit-3 mapping for EAUTOPGSLUGUNKNOWN / EAUTOPGMETAMISSING /
 *     EAUTOPGLOCKEDPARSE
 *   - exit-3 fallback for any other loader exception
 *   - --slug omitted -> live TRUSTED_IDENTITIES path (no loader call)
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runVerify } from '../../src/commands/verify.js';

let tmpBinDir;
let tmpStateRoot;
let stderrBuf;
let stdoutBuf;
let originalStderrWrite;
let originalStdoutWrite;
let originalXdgStateHome;

beforeEach(() => {
  tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-slug-bin-'));
  tmpStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-slug-state-'));
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tmpStateRoot;
  stderrBuf = [];
  stdoutBuf = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk) => { stderrBuf.push(String(chunk)); return true; };
  process.stdout.write = (chunk) => { stdoutBuf.push(String(chunk)); return true; };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  fs.rmSync(tmpBinDir, { recursive: true, force: true });
  fs.rmSync(tmpStateRoot, { recursive: true, force: true });
});

function makeBinary(name = 'postgres') {
  const file = path.join(tmpBinDir, name);
  fs.writeFileSync(file, 'BINARY');
  fs.chmodSync(file, 0o755);
  // bundle sidecar — verifyBinary refuses without one even if cosign is missing.
  fs.writeFileSync(`${file}.bundle`, '{"fake":"bundle"}');
  return file;
}

describe('--slug flag parsing', () => {
  test('--slug with no value (next-arg empty) exits 3', () => {
    const binary = makeBinary();
    const code = runVerify([binary, '--slug', '']);
    expect(code).toBe(3);
    expect(stderrBuf.join('')).toMatch(/--slug requires a non-empty value/);
  });

  test('--slug with whitespace-only value exits 3', () => {
    const binary = makeBinary();
    const code = runVerify([binary, '--slug', '   ']);
    expect(code).toBe(3);
  });

  test('--port with non-integer exits 3', () => {
    const binary = makeBinary();
    const code = runVerify([binary, '--port', 'abc']);
    expect(code).toBe(3);
  });

  test('--port out of range exits 3', () => {
    const binary = makeBinary();
    const code = runVerify([binary, '--port', '70000']);
    expect(code).toBe(3);
  });
});

describe('--slug error mapping', () => {
  test('EAUTOPGSLUGUNKNOWN -> exit 3 with structured stderr', () => {
    const binary = makeBinary();
    const stub = () => {
      const err = new Error('no autopg_meta row for slug "demo"');
      err.code = 'EAUTOPGSLUGUNKNOWN';
      throw err;
    };
    const code = runVerify(
      [binary, '--slug', 'demo', '--no-cache'],
      { loadLockedRoots: stub },
    );
    expect(code).toBe(3);
    const stderr = stderrBuf.join('');
    expect(stderr).toMatch(/slug-lookup-failed/);
    expect(stderr).toMatch(/no autopg_meta row for slug "demo"/);
  });

  test('EAUTOPGMETAMISSING -> exit 3 (table not bootstrapped)', () => {
    const binary = makeBinary();
    const stub = () => {
      const err = new Error('autopg_meta does not exist');
      err.code = 'EAUTOPGMETAMISSING';
      throw err;
    };
    const code = runVerify(
      [binary, '--slug', 'demo', '--no-cache'],
      { loadLockedRoots: stub },
    );
    expect(code).toBe(3);
  });

  test('EAUTOPGLOCKEDPARSE -> exit 3 (malformed JSONB)', () => {
    const binary = makeBinary();
    const stub = () => {
      const err = new Error('locked_roots is malformed');
      err.code = 'EAUTOPGLOCKEDPARSE';
      throw err;
    };
    const code = runVerify(
      [binary, '--slug', 'demo', '--no-cache'],
      { loadLockedRoots: stub },
    );
    expect(code).toBe(3);
  });

  test('unknown loader exception -> exit 3 (postgres unreachable, etc.)', () => {
    const binary = makeBinary();
    const stub = () => {
      throw new Error('connection refused');
    };
    const code = runVerify(
      [binary, '--slug', 'demo', '--no-cache'],
      { loadLockedRoots: stub },
    );
    expect(code).toBe(3);
  });

  test('--json mode emits JSON error payload to stdout (not stderr)', () => {
    const binary = makeBinary();
    const stub = () => {
      const err = new Error('not found');
      err.code = 'EAUTOPGSLUGUNKNOWN';
      throw err;
    };
    const code = runVerify(
      [binary, '--slug', 'demo', '--no-cache', '--json'],
      { loadLockedRoots: stub },
    );
    expect(code).toBe(3);
    const out = stdoutBuf.join('');
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('slug-lookup-failed');
    expect(parsed.slug).toBe('demo');
    expect(parsed.loaderCode).toBe('EAUTOPGSLUGUNKNOWN');
  });
});

describe('--slug omitted', () => {
  test('does not call the loader (live TRUSTED_IDENTITIES path)', () => {
    const binary = makeBinary();
    let loaderCalled = false;
    const stub = () => {
      loaderCalled = true;
      return { lockedRoots: [] };
    };
    // We pass --no-cache + an absent cosign to make verifyBinary fail fast
    // without a real cosign on PATH. The point of this test is that the
    // loader is not invoked when --slug is absent — exit code semantics
    // are verifyBinary's territory and covered by tests/cli/verify.test.js.
    runVerify([binary, '--no-cache'], { loadLockedRoots: stub });
    expect(loaderCalled).toBe(false);
  });
});
