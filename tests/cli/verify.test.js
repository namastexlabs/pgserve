/**
 * Tests for `pgserve verify <binary-path>` — Group 4 acceptance battery.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Drives the wrapper end-to-end:
 *   - legitimate signed binary: passes, cache written, second invocation
 *     short-circuits cosign.
 *   - tampered binary: rejects with diagnostic.
 *   - --skip-sigstore without pretrusted key: refuses non-zero with the
 *     cross-group remediation hint.
 *   - --skip-sigstore with offline-cosign-key entry: passes, marks
 *     self_signed tier in the cache.
 *   - cache mtime invalidation: bumping the binary's mtime forces a fresh
 *     verify (cosign called twice).
 *
 * `cosign` is stubbed on PATH so we don't drag the real verifier into the
 * test loop. The trust list itself stays the hardcoded production list —
 * we override it with PGSERVE_TRUST_LIST_OVERRIDE only for tests that
 * care about identity selection (none of the four acceptance cases do).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

let tmpStateRoot;     // XDG_STATE_HOME for cache tokens
let tmpHome;          // HOME for offline trust file
let tmpBinDir;        // where we drop the fake postgres binary
let stubCosignDir;    // where the stub cosign + its calls log live
let originalEnv;

function makeStubCosign({ allow = 'LEGIT_BINARY_v1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-stub-cosign-'));
  const callLog = path.join(dir, 'calls.log');
  // Hardcode `process.execPath` in the shebang because the child runs with
  // PATH=<stub dir only>, so `#!/usr/bin/env node` would fail to find node.
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'verify-blob') process.exit(2);
const binaryPath = args[args.length - 1];
let body;
try { body = fs.readFileSync(binaryPath, 'utf8'); } catch { process.exit(3); }
if (body.startsWith(${JSON.stringify(allow)})) {
  process.stdout.write('Verified OK\\n');
  process.exit(0);
}
process.stderr.write('cosign-stub: rejected\\n');
process.exit(1);
`;
  const stubPath = path.join(dir, 'cosign');
  fs.writeFileSync(stubPath, script, { mode: 0o755 });
  return { dir, stubPath, callLog };
}

function makeBinary(body) {
  const file = path.join(tmpBinDir, 'postgres');
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function makeBundle(binaryPath) {
  const bundle = `${binaryPath}.bundle`;
  fs.writeFileSync(bundle, '{"fake":"bundle","version":1}');
  return bundle;
}

function readCalls(callLog) {
  if (!fs.existsSync(callLog)) return [];
  return fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runCli(args, env = {}) {
  // Use process.execPath (absolute path to node) so we don't need /usr/bin
  // on PATH. PATH inside the child is set to ONLY the stub cosign dir so
  // the verifier can't accidentally find a real cosign on the host.
  return spawnSync(process.execPath, [BIN, 'verify', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // Cache tokens land under XDG_STATE_HOME/pgserve.
      XDG_STATE_HOME: tmpStateRoot,
      // Offline trust file is read via $HOME/.pgserve/trust/identities.json
      // unless PGSERVE_TRUST_FILE points elsewhere.
      HOME: tmpHome,
      // Cosign comes only from the stub — do NOT inherit the real PATH
      // in case a real cosign sits in front of our stub.
      PATH: stubCosignDir,
      ...env,
    },
  });
}

beforeEach(() => {
  tmpStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-state-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-home-'));
  tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-bin-'));
  const stub = makeStubCosign({});
  stubCosignDir = stub.dir;
  originalEnv = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    HOME: process.env.HOME,
    PGSERVE_TRUST_FILE: process.env.PGSERVE_TRUST_FILE,
  };
});

afterEach(() => {
  fs.rmSync(tmpStateRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpBinDir, { recursive: true, force: true });
  fs.rmSync(stubCosignDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ────────────────────────────────────────────────────────────────────────
// Acceptance #1: legitimate signed binary passes, second call uses cache.
// ────────────────────────────────────────────────────────────────────────

describe('legitimate signed binary', () => {
  test('first invocation calls cosign + writes a 0600 cache token', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\nELF...');
    makeBundle(binary);
    const callLog = path.join(stubCosignDir, 'calls.log');
    const result = runCli([binary, '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.tier).toBe('cosign_signed');
    expect(out.cached).toBe(false);
    expect(typeof out.cacheFile).toBe('string');
    expect(fs.existsSync(out.cacheFile)).toBe(true);
    const mode = fs.statSync(out.cacheFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readCalls(callLog).length).toBe(1);
  });

  test('second invocation hits the cache (cosign NOT called again)', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\nELF...');
    makeBundle(binary);
    const callLog = path.join(stubCosignDir, 'calls.log');

    const first = runCli([binary, '--json']);
    expect(first.status).toBe(0);
    expect(readCalls(callLog).length).toBe(1);

    const second = runCli([binary, '--json']);
    expect(second.status).toBe(0);
    const out = JSON.parse(second.stdout);
    expect(out.ok).toBe(true);
    expect(out.cached).toBe(true);
    expect(out.tier).toBe('cosign_signed');
    // Cosign call count unchanged — cache short-circuited.
    expect(readCalls(callLog).length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Acceptance #2: tampered binary is rejected with diagnostic.
// ────────────────────────────────────────────────────────────────────────

describe('tampered binary', () => {
  test('exits non-zero with diagnostic, does NOT write cache', () => {
    const binary = makeBinary('TAMPERED_PAYLOAD_v1\n');
    makeBundle(binary);
    const result = runCli([binary, '--json']);
    expect(result.status).not.toBe(0);
    const out = JSON.parse(result.stdout || '{}');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no-trust-match');
    // No cache token should have been written.
    const verifiedDir = path.join(tmpStateRoot, 'pgserve', 'verified');
    if (fs.existsSync(verifiedDir)) {
      const files = fs.readdirSync(verifiedDir);
      expect(files.length).toBe(0);
    }
  });

  test('plain (non-JSON) output prints FAILED on stderr', () => {
    const binary = makeBinary('TAMPERED_PAYLOAD_v1\n');
    makeBundle(binary);
    const result = runCli([binary]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAILED');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Acceptance #3: --skip-sigstore without pretrusted key refuses.
// ────────────────────────────────────────────────────────────────────────

describe('--skip-sigstore without pretrusted key', () => {
  test('refuses non-zero with cross-group remediation hint', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\n');
    // Note: NO bundle, NO trust file. --skip-sigstore should not need
    // either, but it must refuse because no offline key is registered.
    const result = runCli([binary, '--skip-sigstore', '--json']);
    expect(result.status).not.toBe(0);
    const out = JSON.parse(result.stdout || '{}');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('skip-sigstore-without-pretrusted-key');
    expect(out.detail).toContain('pgserve trust add --offline-cosign-key');
  });

  test('exits with EXIT_INVOCATION (3) — operator misuse, not verify failure', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\n');
    const result = runCli([binary, '--skip-sigstore']);
    expect(result.status).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Acceptance #3b: --skip-sigstore WITH a pretrusted key passes (self_signed).
// G3 will populate this trust file via `pgserve trust add
// --offline-cosign-key`. Until G3 ships, we test against a hand-written
// fixture in the expected schema.
// ────────────────────────────────────────────────────────────────────────

describe('--skip-sigstore with offline-cosign-key', () => {
  test('passes verification, records self_signed tier in cache', () => {
    const trustDir = path.join(tmpHome, '.pgserve', 'trust');
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(
      path.join(trustDir, 'identities.json'),
      JSON.stringify({
        offlineKeys: [{
          id: 'operator-rebuild-key',
          publisher: '@automagik/pgserve',
          keyFingerprint: 'sha256:deadbeef',
          addedAt: '2026-05-08T00:00:00Z',
        }],
      }, null, 2),
      { mode: 0o600 },
    );
    const binary = makeBinary('OPERATOR_REBUILT_v1\n');
    const result = runCli([binary, '--skip-sigstore', '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.ok).toBe(true);
    expect(out.tier).toBe('self_signed');
    expect(out.identity).toBe('operator-rebuild-key');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Acceptance #4: cache invalidation on binary mtime change.
// ────────────────────────────────────────────────────────────────────────

describe('cache invalidation', () => {
  test('binary mtime change forces a fresh cosign call', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\nv1');
    makeBundle(binary);
    const callLog = path.join(stubCosignDir, 'calls.log');

    const first = runCli([binary, '--json']);
    expect(first.status).toBe(0);
    expect(readCalls(callLog).length).toBe(1);

    // Bump mtime to the future. Re-write content (legit prefix preserved
    // so the second verify still passes — we're testing invalidation, not
    // tamper detection).
    fs.writeFileSync(binary, 'LEGIT_BINARY_v1\nv2-with-different-bytes');
    const future = new Date(Date.now() + 60 * 1000);
    fs.utimesSync(binary, future, future);

    const second = runCli([binary, '--json']);
    expect(second.status).toBe(0);
    const out = JSON.parse(second.stdout);
    expect(out.ok).toBe(true);
    expect(out.cached).toBe(false);
    // Cosign was invoked again because the cached attestation no longer
    // matches the binary's mtime/size.
    expect(readCalls(callLog).length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Misuse: missing binary, missing bundle.
// ────────────────────────────────────────────────────────────────────────

describe('invocation errors', () => {
  test('missing binary path → EXIT_INVOCATION (3) + binary-missing', () => {
    const result = runCli([path.join(tmpBinDir, 'no-such-file'), '--json']);
    expect(result.status).toBe(3);
    const out = JSON.parse(result.stdout || '{}');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('binary-missing');
  });

  test('missing bundle sidecar → EXIT_INVOCATION (3) + bundle-missing', () => {
    const binary = makeBinary('LEGIT_BINARY_v1\n');
    // intentionally NO bundle file.
    const result = runCli([binary, '--json']);
    expect(result.status).toBe(3);
    const out = JSON.parse(result.stdout || '{}');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('bundle-missing');
  });

  test('no positional arg → prints help and exits 3', () => {
    const result = runCli(['--json']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('pgserve verify');
  });

  test('--help exits 0 and prints usage', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pgserve verify');
  });
});
