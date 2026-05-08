/**
 * Tests for src/cosign/cache-token.js — HMAC-signed verification cache.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Strategy: each test owns its own tempdir which we wire as the
 * `XDG_STATE_HOME` so `getStateDir()` resolves under the tempdir without
 * touching the real `~/.local/state`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTokenPayload,
  computeBinaryAttestation,
  deleteCacheToken,
  ensureHmacKey,
  getHmacKeyPath,
  getStateDir,
  getTokenPath,
  getVerifiedDir,
  HMAC_KEY_BYTES,
  readCacheToken,
  SLIDING_IDLE_MS,
  SLIDING_MAX_MS,
  TOKEN_VERSION,
  touchCacheToken,
  writeCacheToken,
} from '../../src/cosign/cache-token.js';

let tmpStateRoot;
let tmpBinDir;
let originalXdg;

function makeBinary(name = 'fake-postgres', body = 'LEGIT_BINARY_v1') {
  const file = path.join(tmpBinDir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmpStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cache-test-'));
  tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cache-bin-'));
  originalXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = tmpStateRoot;
});

afterEach(() => {
  fs.rmSync(tmpStateRoot, { recursive: true, force: true });
  fs.rmSync(tmpBinDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdg;
});

describe('getStateDir resolves under XDG_STATE_HOME', () => {
  test('returns $XDG_STATE_HOME/pgserve when set', () => {
    expect(getStateDir()).toBe(path.join(tmpStateRoot, 'pgserve'));
  });

  test('verified dir is $XDG_STATE_HOME/pgserve/verified', () => {
    expect(getVerifiedDir()).toBe(path.join(tmpStateRoot, 'pgserve', 'verified'));
  });

  test('hmac key path is $XDG_STATE_HOME/pgserve/cache.hmac', () => {
    expect(getHmacKeyPath()).toBe(path.join(tmpStateRoot, 'pgserve', 'cache.hmac'));
  });
});

describe('ensureHmacKey', () => {
  test('creates the key file with mode 0600 on first call', () => {
    const key = ensureHmacKey();
    expect(key.length).toBe(HMAC_KEY_BYTES);
    const file = getHmacKeyPath();
    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('returns the same bytes across calls', () => {
    const a = ensureHmacKey();
    const b = ensureHmacKey();
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test('regenerates when file is wrong-sized (treats as cache poisoning)', () => {
    ensureHmacKey();
    fs.writeFileSync(getHmacKeyPath(), 'too-short');
    const fresh = ensureHmacKey();
    expect(fresh.length).toBe(HMAC_KEY_BYTES);
  });
});

describe('getTokenPath', () => {
  test('rejects fingerprints with shell-unsafe characters', () => {
    expect(() => getTokenPath('a/b')).toThrow(/unsafe/);
    expect(() => getTokenPath('a b')).toThrow(/unsafe/);
    expect(() => getTokenPath('')).toThrow(/non-empty/);
  });

  test('accepts dotted hex-style fingerprints', () => {
    expect(() => getTokenPath('postgres.0123abcd')).not.toThrow();
  });
});

describe('writeCacheToken + readCacheToken — round trip', () => {
  test('writes a 0600 token and reads it back', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const payload = buildTokenPayload({
      fingerprint: 'fake.aaaa1111',
      binary: attestation,
      identity: 'automagik-pgserve-release',
      tier: 'cosign_signed',
      sha256: 'aaaa1111',
    });
    const tokenFile = writeCacheToken(payload, {});
    expect(fs.existsSync(tokenFile)).toBe(true);
    const mode = fs.statSync(tokenFile).mode & 0o777;
    expect(mode).toBe(0o600);

    const loaded = readCacheToken('fake.aaaa1111', { binaryAttestation: attestation });
    expect(loaded.ok).toBe(true);
    expect(loaded.payload.identity).toBe('automagik-pgserve-release');
    expect(loaded.payload.tier).toBe('cosign_signed');
    expect(loaded.payload.v).toBe(TOKEN_VERSION);
  });

  test('detects HMAC tampering (corrupted envelope.mac)', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const payload = buildTokenPayload({
      fingerprint: 'fake.bbbb2222',
      binary: attestation,
      identity: 'automagik-genie-release',
      tier: 'cosign_signed',
      sha256: 'bbbb2222',
    });
    const tokenFile = writeCacheToken(payload, {});
    const envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    envelope.mac = '0'.repeat(envelope.mac.length);
    fs.writeFileSync(tokenFile, JSON.stringify(envelope));

    const loaded = readCacheToken('fake.bbbb2222', { binaryAttestation: attestation });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('hmac-mismatch');
  });

  test('detects payload tampering (mac ok, payload mutated)', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const payload = buildTokenPayload({
      fingerprint: 'fake.cccc3333',
      binary: attestation,
      identity: 'automagik-genie-release',
      tier: 'cosign_signed',
      sha256: 'cccc3333',
    });
    const tokenFile = writeCacheToken(payload, {});
    const envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    envelope.payload = envelope.payload.replace('cosign_signed', 'self_signed___');
    fs.writeFileSync(tokenFile, JSON.stringify(envelope));

    const loaded = readCacheToken('fake.cccc3333', { binaryAttestation: attestation });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('hmac-mismatch');
  });
});

describe('binary-attestation invalidation', () => {
  test('mtime change invalidates the cached token', () => {
    const file = makeBinary('postgres', 'before-mtime-bump');
    const attestation = computeBinaryAttestation(file);
    const payload = buildTokenPayload({
      fingerprint: 'postgres.dddd4444',
      binary: attestation,
      identity: 'automagik-pgserve-release',
      tier: 'cosign_signed',
      sha256: 'dddd4444',
    });
    writeCacheToken(payload, {});

    // Bump the mtime (simulate "operator updated the binary").
    const future = new Date(Date.now() + 60 * 1000);
    fs.utimesSync(file, future, future);
    const newAttestation = computeBinaryAttestation(file);

    const loaded = readCacheToken('postgres.dddd4444', { binaryAttestation: newAttestation });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('binary-changed');
  });

  test('size change invalidates the cached token', () => {
    const file = makeBinary('pg-tools', 'short');
    const attestation = computeBinaryAttestation(file);
    writeCacheToken(buildTokenPayload({
      fingerprint: 'pg-tools.eeee5555',
      binary: attestation,
      identity: 'automagik-pgserve-release',
      tier: 'cosign_signed',
      sha256: 'eeee5555',
    }), {});

    fs.writeFileSync(file, 'a-completely-different-and-larger-payload');
    const loaded = readCacheToken('pg-tools.eeee5555', { binaryAttestation: computeBinaryAttestation(file) });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('binary-changed');
  });
});

describe('sliding expiry', () => {
  test('lapses on idle window', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const oldNow = Date.now() - SLIDING_IDLE_MS - 1000;
    const payload = buildTokenPayload({
      fingerprint: 'idle.ffff6666',
      binary: attestation,
      identity: 'automagik-genie-release',
      tier: 'cosign_signed',
      sha256: 'ffff6666',
      now: oldNow,
    });
    writeCacheToken(payload, {});
    const loaded = readCacheToken('idle.ffff6666', { binaryAttestation: attestation });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('expired-idle');
  });

  test('lapses on absolute max window', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const veryOld = Date.now() - SLIDING_MAX_MS - 1000;
    const payload = buildTokenPayload({
      fingerprint: 'max.7777aaaa',
      binary: attestation,
      identity: 'automagik-genie-release',
      tier: 'cosign_signed',
      sha256: '7777aaaa',
      now: veryOld,
    });
    writeCacheToken(payload, {});
    // Bump lastUsedAt to "now" so idle alone wouldn't trip — only max should.
    const tokenFile = getTokenPath('max.7777aaaa');
    const envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const innerPayload = JSON.parse(envelope.payload);
    innerPayload.lastUsedAt = Date.now();
    // Re-write deterministically. We can't sign without re-running writeCacheToken,
    // so produce a fresh payload that keeps `createdAt` ancient but lastUsedAt fresh.
    writeCacheToken({ ...innerPayload }, {});

    const loaded = readCacheToken('max.7777aaaa', { binaryAttestation: attestation });
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe('expired-max');
  });
});

describe('touchCacheToken bumps lastUsedAt', () => {
  test('rewrites the token with a fresher lastUsedAt', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    const oldNow = Date.now() - 30 * 60 * 1000; // 30 min ago
    const payload = buildTokenPayload({
      fingerprint: 'touch.8888bbbb',
      binary: attestation,
      identity: 'automagik-genie-release',
      tier: 'cosign_signed',
      sha256: '8888bbbb',
      now: oldNow,
    });
    writeCacheToken(payload, {});
    const before = readCacheToken('touch.8888bbbb', { binaryAttestation: attestation });
    expect(before.ok).toBe(true);
    const bumped = touchCacheToken(before.payload, {});
    expect(bumped).not.toBeNull();
    expect(bumped.lastUsedAt).toBeGreaterThan(before.payload.lastUsedAt);
  });
});

describe('deleteCacheToken', () => {
  test('removes an existing token file (returns true)', () => {
    const file = makeBinary();
    const attestation = computeBinaryAttestation(file);
    writeCacheToken(buildTokenPayload({
      fingerprint: 'del.9999cccc',
      binary: attestation,
      identity: 'automagik-pgserve-release',
      tier: 'cosign_signed',
      sha256: '9999cccc',
    }), {});
    expect(deleteCacheToken('del.9999cccc', {})).toBe(true);
    expect(fs.existsSync(getTokenPath('del.9999cccc'))).toBe(false);
  });

  test('returns false on missing file', () => {
    expect(deleteCacheToken('does-not-exist', {})).toBe(false);
  });
});
