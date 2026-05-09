/**
 * Tests for src/cosign/verify-binary.js — cosign keyless verifier shim.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Strategy: stub `cosign` on a temp PATH (cheaper than installing a real
 * cosign + cooking real signatures). The stub:
 *   - exit 0 if the binary content begins with `LEGIT_BINARY_v1`,
 *   - exit 1 otherwise.
 * That gives us the four behaviors we need (legit pass / tampered reject /
 * trust-root iteration / cosign-missing diagnostics) without dragging
 * Sigstore into the test loop.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveBundleCandidates,
  resolveBundlePath,
  sha256File,
  verifyBinary,
} from '../../src/cosign/verify-binary.js';

const FAKE_TRUST_LIST = [
  Object.freeze({
    id: 'fake-genie-release',
    publisher: '@automagik/genie',
    issuer: 'https://token.actions.githubusercontent.com',
    identityRegexp: '^https://github.com/automagik-dev/genie/.*$',
    description: 'fake genie identity (test fixture)',
  }),
];

let tmpRoot;
let stubBinDir;
let stubLog;

function makeStubCosign({ allow = 'LEGIT_BINARY_v1' } = {}) {
  // Stubs cosign verify-blob. Exits 0 when the binary's first bytes match
  // `allow`; non-zero otherwise. Records every invocation as JSON lines.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cosign-stub-'));
  const callLog = path.join(dir, 'calls.log');
  // Hardcode `process.execPath` in the shebang so the stub doesn't need
  // /usr/bin/env or `node` on the child's PATH (callers may scrub it).
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');

if (args[0] !== 'verify-blob') {
  process.stderr.write('cosign-stub: unsupported subcommand ' + args[0] + '\\n');
  process.exit(2);
}

// Last arg is the binary path.
const binaryPath = args[args.length - 1];
let body;
try { body = fs.readFileSync(binaryPath, 'utf8'); }
catch (err) {
  process.stderr.write('cosign-stub: cannot read ' + binaryPath + ': ' + err.message + '\\n');
  process.exit(3);
}

const allow = ${JSON.stringify(allow)};
if (body.startsWith(allow)) {
  process.stdout.write('Verified OK\\n');
  process.exit(0);
}
process.stderr.write('cosign-stub: rejected — body did not start with allow marker\\n');
process.exit(1);
`;
  const stubPath = path.join(dir, 'cosign');
  fs.writeFileSync(stubPath, script, { mode: 0o755 });
  return { dir, stubPath, callLog };
}

function makeBinary(name, body) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

function makeBundle(binaryPath, body = '{"fake":"bundle"}') {
  const bundle = resolveBundlePath(binaryPath);
  fs.writeFileSync(bundle, body);
  return bundle;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-verify-bin-'));
  const stub = makeStubCosign({});
  stubBinDir = stub.dir;
  stubLog = stub.callLog;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(stubBinDir, { recursive: true, force: true });
});

function readCallLog() {
  if (!fs.existsSync(stubLog)) return [];
  return fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('verifyBinary — happy path', () => {
  test('returns ok with identity + cosign tier when stub cosign passes', () => {
    const binary = makeBinary('postgres', 'LEGIT_BINARY_v1\nELF\0...');
    makeBundle(binary);
    const result = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(true);
    expect(result.identity).toBe('fake-genie-release');
    expect(result.tier).toBe('cosign_signed');
    expect(result.sha256).toBe(sha256File(binary));
    expect(result.cosignBin).toBe(path.join(stubBinDir, 'cosign'));
  });

  test('invokes cosign with verify-blob + identity flags', () => {
    const binary = makeBinary('postgres-1', 'LEGIT_BINARY_v1\nrest');
    makeBundle(binary);
    verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    const calls = readCallLog();
    expect(calls.length).toBe(1);
    const args = calls[0];
    expect(args[0]).toBe('verify-blob');
    expect(args).toContain('--bundle');
    expect(args).toContain('--certificate-identity-regexp');
    expect(args).toContain('--certificate-oidc-issuer');
    expect(args[args.length - 1]).toBe(binary);
  });
});

describe('verifyBinary — rejection paths', () => {
  test('tampered binary content → no-trust-match', () => {
    const binary = makeBinary('postgres-tampered', 'TAMPERED_BINARY\nELF\0...');
    makeBundle(binary);
    const result = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-trust-match');
    expect(result.identityChain).toBeDefined();
    expect(result.identityChain[0].status).toBe('rejected');
  });

  test('missing bundle → bundle-missing', () => {
    const binary = makeBinary('no-bundle', 'LEGIT_BINARY_v1\n');
    const result = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bundle-missing');
  });

  test('missing binary → binary-missing', () => {
    const result = verifyBinary(path.join(tmpRoot, 'nonexistent'), {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binary-missing');
  });

  test('binary path is a directory → binary-not-a-file', () => {
    const dir = path.join(tmpRoot, 'a-dir');
    fs.mkdirSync(dir);
    const result = verifyBinary(dir, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('binary-not-a-file');
  });

  test('cosign rejection from a stub that always fails → no-trust-match', () => {
    // Build a second stub that rejects unconditionally — exercises the
    // failure path without depending on host PATH state. The
    // cosign-missing branch is exercised by the CLI tests where we can
    // fully control PATH + HOME.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cosign-fail-'));
    const stubPath = path.join(dir, 'cosign');
    fs.writeFileSync(stubPath, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
    try {
      const binary = makeBinary('postgres-2', 'LEGIT_BINARY_v1\n');
      makeBundle(binary);
      const result = verifyBinary(binary, {
        cosignBin: stubPath,
        trustList: FAKE_TRUST_LIST,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no-trust-match');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyBinary — input validation', () => {
  test('rejects empty binaryPath', () => {
    const r = verifyBinary('', { trustList: FAKE_TRUST_LIST });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid-args');
  });

  test('rejects empty trust list', () => {
    const binary = makeBinary('p-empty', 'LEGIT_BINARY_v1');
    makeBundle(binary);
    const r = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: [],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty-trust-list');
  });
});

describe('CV-VERIFY-BUNDLE-NAMING — resolveBundleCandidates (v2.6.3)', () => {
  test('returns three candidates in priority order', () => {
    const candidates = resolveBundleCandidates('/tmp/foo/bar.tgz');
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toBe('/tmp/foo/bar.tgz.bundle');
    expect(candidates[1]).toBe('/tmp/foo/bar.intoto.jsonl');
    expect(candidates[2]).toBe('/tmp/foo/provenance.intoto.jsonl');
  });

  test('strips trailing .tgz only (preserves other archive shapes verbatim in stem position)', () => {
    const candidates = resolveBundleCandidates('/tmp/foo/bar.tar.gz');
    expect(candidates[0]).toBe('/tmp/foo/bar.tar.gz.bundle');
    // .tar.gz is not stripped (only .tgz is); stem stays as-is
    expect(candidates[1]).toBe('/tmp/foo/bar.tar.gz.intoto.jsonl');
    expect(candidates[2]).toBe('/tmp/foo/provenance.intoto.jsonl');
  });

  test('binary with no extension keeps its full name in candidate slots', () => {
    const candidates = resolveBundleCandidates('/tmp/foo/postgres');
    expect(candidates[0]).toBe('/tmp/foo/postgres.bundle');
    expect(candidates[1]).toBe('/tmp/foo/postgres.intoto.jsonl');
    expect(candidates[2]).toBe('/tmp/foo/provenance.intoto.jsonl');
  });
});

describe('CV-VERIFY-BUNDLE-NAMING — resolveBundlePath fall-through (v2.6.3)', () => {
  test('candidate 1 (`<binary>.bundle`) wins when present (preserves existing convention)', () => {
    const binary = makeBinary('artifact-1.tgz', 'BODY');
    fs.writeFileSync(`${binary}.bundle`, '{"shape":"bundle"}');
    expect(resolveBundlePath(binary)).toBe(`${binary}.bundle`);
  });

  test('candidate 2 (`<stem>.intoto.jsonl`) wins when only that exists (per-artifact provenance)', () => {
    const binary = makeBinary('artifact-2.tgz', 'BODY');
    const stem = binary.replace(/\.tgz$/, '');
    fs.writeFileSync(`${stem}.intoto.jsonl`, '{"shape":"intoto-stem"}');
    expect(resolveBundlePath(binary)).toBe(`${stem}.intoto.jsonl`);
  });

  test('candidate 3 (`<dirname>/provenance.intoto.jsonl`) wins when only that exists (genie shape)', () => {
    const binary = makeBinary('artifact-3.tgz', 'BODY');
    const sibling = path.join(path.dirname(binary), 'provenance.intoto.jsonl');
    fs.writeFileSync(sibling, '{"shape":"intoto-sibling"}');
    expect(resolveBundlePath(binary)).toBe(sibling);
  });

  test('priority order: candidate 1 beats candidate 3 when both exist', () => {
    const binary = makeBinary('artifact-4.tgz', 'BODY');
    fs.writeFileSync(`${binary}.bundle`, '{"shape":"bundle"}');
    const sibling = path.join(path.dirname(binary), 'provenance.intoto.jsonl');
    fs.writeFileSync(sibling, '{"shape":"intoto-sibling"}');
    // Candidate 1 (`.bundle`) takes priority — existing convention preserved.
    expect(resolveBundlePath(binary)).toBe(`${binary}.bundle`);
  });

  test('priority order: candidate 2 beats candidate 3 when 1 absent and both 2+3 exist', () => {
    const binary = makeBinary('artifact-5.tgz', 'BODY');
    const stem = binary.replace(/\.tgz$/, '');
    fs.writeFileSync(`${stem}.intoto.jsonl`, '{"shape":"intoto-stem"}');
    const sibling = path.join(path.dirname(binary), 'provenance.intoto.jsonl');
    fs.writeFileSync(sibling, '{"shape":"intoto-sibling"}');
    expect(resolveBundlePath(binary)).toBe(`${stem}.intoto.jsonl`);
  });

  test('all candidates absent → returns candidate 1 (preserves bundle-missing error path)', () => {
    const binary = makeBinary('artifact-6.tgz', 'BODY');
    // No bundle/intoto files written.
    expect(resolveBundlePath(binary)).toBe(`${binary}.bundle`);
  });
});

describe('CV-VERIFY-BUNDLE-NAMING — verifyBinary bundle-missing detail enrichment (v2.6.3)', () => {
  test('bundle-missing error lists all three probed paths when no override is set', () => {
    const binary = makeBinary('artifact-missing.tgz', 'BODY');
    // No bundle/intoto files written.
    const result = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bundle-missing');
    expect(result.detail).toContain(`${binary}.bundle`);
    expect(result.detail).toContain(`.intoto.jsonl`);
    expect(result.detail).toContain(`provenance.intoto.jsonl`);
    // Hint must reference --bundle override since fall-through couldn't resolve.
    expect(result.detail).toContain('--bundle');
  });

  test('bundle-missing error lists ONLY the override path when --bundle was passed', () => {
    const binary = makeBinary('artifact-with-override.tgz', 'BODY');
    const explicit = `${binary}.does-not-exist`;
    const result = verifyBinary(binary, {
      cosignBin: path.join(stubBinDir, 'cosign'),
      trustList: FAKE_TRUST_LIST,
      bundlePath: explicit,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bundle-missing');
    expect(result.detail).toContain(explicit);
    // The auto-discovery probe paths should NOT appear when an override was given.
    expect(result.detail).not.toContain('provenance.intoto.jsonl');
  });
});
