/**
 * Tests for the hardcoded blocklist (pgserve-singleton-no-proxy G5).
 */

import { test, expect, describe, afterEach } from 'bun:test';
import {
  BLOCKED_VERSIONS,
  findBlocked,
  assertNotBlocked,
  __addBlockedForTest,
  __clearBlockedTestOverridesForTest,
} from '../../src/security/blocked-versions.js';

afterEach(() => {
  __clearBlockedTestOverridesForTest();
});

describe('BLOCKED_VERSIONS export', () => {
  test('is a frozen array', () => {
    expect(Array.isArray(BLOCKED_VERSIONS)).toBe(true);
    expect(Object.isFrozen(BLOCKED_VERSIONS)).toBe(true);
  });

  test('every entry has a non-empty version + reason', () => {
    for (const entry of BLOCKED_VERSIONS) {
      expect(typeof entry.version).toBe('string');
      expect(entry.version.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test('default ships empty (no shipped binaries are pre-blocked)', () => {
    expect(BLOCKED_VERSIONS.length).toBe(0);
  });
});

describe('findBlocked', () => {
  test('returns undefined for unknown version', () => {
    expect(findBlocked('99.99.99')).toBeUndefined();
  });

  test('returns undefined for non-string input', () => {
    expect(findBlocked(undefined)).toBeUndefined();
    expect(findBlocked(null)).toBeUndefined();
    expect(findBlocked(42)).toBeUndefined();
    expect(findBlocked('')).toBeUndefined();
  });

  test('returns the entry when an injected version is blocked', () => {
    __addBlockedForTest({ version: '0.0.0-test', reason: 'fixture' });
    expect(findBlocked('0.0.0-test')).toEqual({ version: '0.0.0-test', reason: 'fixture' });
  });
});

describe('assertNotBlocked', () => {
  test('does not throw for unknown version', () => {
    expect(() => assertNotBlocked('99.99.99')).not.toThrow();
  });

  test('does not throw for empty/non-string input', () => {
    expect(() => assertNotBlocked(undefined)).not.toThrow();
    expect(() => assertNotBlocked('')).not.toThrow();
  });

  test('throws EBLOCKEDVERSION when an injected blocked version is hit', () => {
    __addBlockedForTest({
      version: '0.0.0-bad',
      reason: 'crashes at startup',
    });
    let caught;
    try {
      assertNotBlocked('0.0.0-bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EBLOCKEDVERSION');
    expect(caught.version).toBe('0.0.0-bad');
    expect(caught.reason).toBe('crashes at startup');
    expect(caught.message.startsWith('EBLOCKEDVERSION: pgserve@0.0.0-bad is blocked.')).toBe(true);
    expect(caught.message).toContain('reason: crashes at startup');
    expect(caught.message).toContain('remediation:');
  });

  test('includes advisoryUrl in the message when provided', () => {
    __addBlockedForTest({
      version: '0.0.0-cve',
      reason: 'CVE-2026-9999',
      advisoryUrl: 'https://example.test/advisory',
    });
    let caught;
    try {
      assertNotBlocked('0.0.0-cve');
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toContain('advisory: https://example.test/advisory');
  });

  test('test override is cleared between tests (isolation check)', () => {
    // Previous tests registered overrides; afterEach should have wiped them.
    expect(findBlocked('0.0.0-bad')).toBeUndefined();
    expect(findBlocked('0.0.0-cve')).toBeUndefined();
  });
});

describe('test overrides do not leak into production code path', () => {
  test('BLOCKED_VERSIONS itself is unaffected by overrides', () => {
    __addBlockedForTest({ version: '0.0.0-leak-check', reason: 'test' });
    expect(BLOCKED_VERSIONS.length).toBe(0);
    expect(BLOCKED_VERSIONS.find((b) => b.version === '0.0.0-leak-check')).toBeUndefined();
  });
});
