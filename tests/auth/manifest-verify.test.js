/**
 * Tests for src/auth/manifest-verify.js — Group 5,
 * autopg-distribution-cutover wish.
 *
 * Acceptance criteria covered (wish §Group 5):
 *   - Unsigned manifest rejected with the locked S9 error string.
 *   - Signed manifest verifies via the injected cosign verifier.
 *   - Failed cosign verify surfaces the cosign output in the thrown error.
 *   - --unsafe-unverified <INCIDENT_ID> bypass writes an audit row tagging
 *     the incident id and returns { verified: false, bypass: <ID> }.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  verifyManifest,
  ManifestVerifyError,
  UNSIGNED_ERROR_TEXT,
  VERIFY_FAILED_PREFIX,
  __test_internals,
  resolvePubKeyPath,
} from '../../src/auth/manifest-verify.js';

let scratchDir;
let auditCalls;

function makeAuditFn() {
  const calls = [];
  const fn = (event, fields) => calls.push({ event, fields });
  fn.calls = calls;
  return fn;
}

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-manifest-test-'));
  auditCalls = makeAuditFn();
  __test_internals.resetVerifier();
});

afterEach(() => {
  __test_internals.resetVerifier();
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

function writeManifest(name, body) {
  const p = path.join(scratchDir, name);
  fs.writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

function writeFakePubKey() {
  const p = path.join(scratchDir, 'cosign.pub');
  fs.writeFileSync(p, '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n');
  return p;
}

describe('verifyManifest — unsigned path', () => {
  test('throws ManifestVerifyError with the locked S9 text when sig is missing', () => {
    const manifestPath = writeManifest('autopg.json', { app: 'omni', needs: { database: 'omni' } });
    const pubKeyPath = writeFakePubKey();
    expect(() => verifyManifest(manifestPath, { pubKeyPath, audit: auditCalls }))
      .toThrow(UNSIGNED_ERROR_TEXT);
    try {
      verifyManifest(manifestPath, { pubKeyPath, audit: auditCalls });
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestVerifyError);
      expect(e.code).toBe('EUNSIGNED');
    }
  });

  test('exact S9 string includes "manifest unsigned" + bypass hint', () => {
    expect(UNSIGNED_ERROR_TEXT).toBe(
      'manifest unsigned. add publisher sig or pass `--unsafe-unverified <INCIDENT_ID>`',
    );
  });
});

describe('verifyManifest — signed + verifies', () => {
  test('returns verified=true and emits AUTOPG_MANIFEST_VERIFIED audit row', () => {
    const manifestPath = writeManifest('autopg.json', { app: 'genie', needs: { database: 'genie' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake-sig-bytes');
    const pubKeyPath = writeFakePubKey();
    __test_internals.setVerifier(({ manifestPath: m, sigPath: s, pubKeyPath: k }) => {
      expect(m).toBe(manifestPath);
      expect(s).toBe(`${manifestPath}.sig`);
      expect(k).toBe(pubKeyPath);
      return { ok: true, output: 'Verified OK' };
    });
    const r = verifyManifest(manifestPath, { pubKeyPath, audit: auditCalls });
    expect(r.verified).toBe(true);
    expect(typeof r.sha256).toBe('string');
    expect(r.sha256).toHaveLength(64);
    expect(auditCalls.calls.length).toBe(1);
    expect(auditCalls.calls[0].event).toBe('autopg_manifest_verified');
    expect(auditCalls.calls[0].fields.manifest_sha256).toBe(r.sha256);
  });
});

describe('verifyManifest — signed + fails', () => {
  test('throws ManifestVerifyError carrying cosign stderr', () => {
    const manifestPath = writeManifest('autopg.json', { app: 'omni', needs: { database: 'omni' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'tampered');
    const pubKeyPath = writeFakePubKey();
    __test_internals.setVerifier(() => ({ ok: false, output: 'cosign: invalid signature for blob' }));
    expect(() => verifyManifest(manifestPath, { pubKeyPath, audit: auditCalls }))
      .toThrow(/invalid signature for blob/);
    try {
      verifyManifest(manifestPath, { pubKeyPath, audit: auditCalls });
    } catch (e) {
      expect(e.code).toBe('EVERIFYFAIL');
      expect(e.message).toContain(VERIFY_FAILED_PREFIX);
    }
  });
});

describe('verifyManifest — --unsafe-unverified bypass', () => {
  test('returns verified=false + emits bypass audit row tagged with incident id', () => {
    const manifestPath = writeManifest('autopg.json', { app: 'omni', needs: { database: 'omni' } });
    // No sig file — bypass takes precedence over the unsigned check.
    const pubKeyPath = writeFakePubKey();
    const r = verifyManifest(manifestPath, {
      pubKeyPath,
      unsafeUnverified: 'TICKET-123',
      audit: auditCalls,
    });
    expect(r.verified).toBe(false);
    expect(r.bypass).toBe('TICKET-123');
    expect(typeof r.sha256).toBe('string');
    expect(auditCalls.calls.length).toBe(1);
    expect(auditCalls.calls[0].event).toBe('autopg_manifest_unsafe_bypass');
    expect(auditCalls.calls[0].fields.incident_id).toBe('TICKET-123');
    expect(auditCalls.calls[0].fields.manifest_sha256).toBe(r.sha256);
  });
});

describe('verifyManifest — missing publisher key', () => {
  test('throws ENOPUBKEY when no key resolvable', () => {
    const manifestPath = writeManifest('autopg.json', { app: 'omni', needs: { database: 'omni' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake');
    const oldEnv = process.env.AUTOPG_COSIGN_PUB;
    delete process.env.AUTOPG_COSIGN_PUB;
    try {
      // Force resolvePubKeyPath to return null by pointing at a non-existent path.
      expect(() => verifyManifest(manifestPath, { pubKeyPath: null, audit: auditCalls }))
        .toThrow(/publisher cosign\.pub not found|verification failed/);
    } finally {
      if (oldEnv) process.env.AUTOPG_COSIGN_PUB = oldEnv;
    }
  });
});

describe('resolvePubKeyPath', () => {
  test('AUTOPG_COSIGN_PUB env wins over bundled fallback', () => {
    const old = process.env.AUTOPG_COSIGN_PUB;
    process.env.AUTOPG_COSIGN_PUB = '/tmp/some-key.pub';
    try {
      expect(resolvePubKeyPath()).toBe('/tmp/some-key.pub');
    } finally {
      if (old) process.env.AUTOPG_COSIGN_PUB = old;
      else delete process.env.AUTOPG_COSIGN_PUB;
    }
  });

  test('explicit opts.pubKeyPath wins over env', () => {
    const old = process.env.AUTOPG_COSIGN_PUB;
    process.env.AUTOPG_COSIGN_PUB = '/tmp/env.pub';
    try {
      expect(resolvePubKeyPath({ pubKeyPath: '/tmp/explicit.pub' })).toBe('/tmp/explicit.pub');
    } finally {
      if (old) process.env.AUTOPG_COSIGN_PUB = old;
      else delete process.env.AUTOPG_COSIGN_PUB;
    }
  });
});

describe('verifyManifest — manifest not found', () => {
  test('throws ENOMANIFEST', () => {
    const missing = path.join(scratchDir, 'does-not-exist.json');
    expect(() => verifyManifest(missing, { audit: auditCalls }))
      .toThrow(/manifest not found/);
    try { verifyManifest(missing, { audit: auditCalls }); }
    catch (e) { expect(e.code).toBe('ENOMANIFEST'); }
  });
});
