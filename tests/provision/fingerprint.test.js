/**
 * Tests for the fingerprint resolver (singleton G3 provision foundation).
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveFingerprint, __testInternals } from '../../src/provision/fingerprint.js';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-fp-test-'));
});
afterEach(() => {
  if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

function writePkg(obj) {
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(obj));
}

describe('precedence', () => {
  test('explicit fingerprint wins over package.json', () => {
    writePkg({ name: 'x', version: '1.0.0' });
    const r = resolveFingerprint({ cwd: tmp, explicit: 'pinned-by-cli' });
    expect(r.fingerprint).toBe('pinned-by-cli');
    expect(r.kind).toBe('pinned');
    // publisher still sourced from package.json
    expect(r.publisher).toBe('x');
  });

  test('package.json pgserve.fingerprint pins the value verbatim', () => {
    writePkg({ name: 'x', version: '1.0.0', pgserve: { fingerprint: 'manual-pin' } });
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.fingerprint).toBe('manual-pin');
    expect(r.kind).toBe('pinned');
  });

  test('name+version → sha256(`<name>@<version>`)', () => {
    writePkg({ name: '@automagik/genie', version: '4.260508.3' });
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.fingerprint).toBe(sha256('@automagik/genie@4.260508.3'));
    expect(r.kind).toBe('name+version');
  });

  test('name only → sha256(name)', () => {
    writePkg({ name: '@automagik/genie' });
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.fingerprint).toBe(sha256('@automagik/genie'));
    expect(r.kind).toBe('name');
  });

  test('no package.json → sha256(absolute cwd)', () => {
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.fingerprint).toBe(sha256(path.resolve(tmp)));
    expect(r.kind).toBe('cwd');
    expect(r.publisher).toBe('');
    expect(r.packageJson).toBeNull();
  });
});

describe('publisher resolution', () => {
  test('prefers package.json#pgserve.publisher', () => {
    writePkg({ name: 'pkg', pgserve: { publisher: '@automagik/custom' } });
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.publisher).toBe('@automagik/custom');
  });

  test('falls back to package.json#name', () => {
    writePkg({ name: '@automagik/genie' });
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.publisher).toBe('@automagik/genie');
  });

  test('empty when no package.json found', () => {
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.publisher).toBe('');
  });
});

describe('determinism', () => {
  test('same package.json → identical fingerprint across calls', () => {
    writePkg({ name: 'pkg', version: '1.2.3' });
    const a = resolveFingerprint({ cwd: tmp });
    const b = resolveFingerprint({ cwd: tmp });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test('cwd-fallback fingerprint differs across paths', () => {
    const a = resolveFingerprint({ cwd: tmp });
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-fp-test2-'));
    try {
      const b = resolveFingerprint({ cwd: tmp2 });
      expect(a.fingerprint).not.toBe(b.fingerprint);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe('error handling', () => {
  test('throws EFINGERPRINTPKG on invalid package.json JSON', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{not-json');
    let caught;
    try {
      resolveFingerprint({ cwd: tmp });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EFINGERPRINTPKG');
  });

  test('non-object package.json (e.g. JSON null) is treated as no package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), 'null');
    const r = resolveFingerprint({ cwd: tmp });
    expect(r.kind).toBe('cwd');
  });
});

describe('__testInternals', () => {
  test('sha256Hex matches node:crypto sha256 hex', () => {
    expect(__testInternals.sha256Hex('abc')).toBe(sha256('abc'));
  });

  test('derivePublisher handles missing package gracefully', () => {
    expect(__testInternals.derivePublisher(null)).toBe('');
    expect(__testInternals.derivePublisher({})).toBe('');
  });
});
