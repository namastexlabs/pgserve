/**
 * Tests for pg_advisory_lock key derivation (singleton G3 provision foundation).
 */

import { test, expect, describe } from 'bun:test';
import {
  deriveBigintKey,
  deriveInt4Pair,
  buildAdvisoryLockSql,
  __testInternals,
} from '../../src/provision/advisory-lock.js';

describe('deriveBigintKey', () => {
  test('returns a BigInt', () => {
    const k = deriveBigintKey('abc');
    expect(typeof k).toBe('bigint');
  });

  test('is deterministic', () => {
    expect(deriveBigintKey('xyz')).toBe(deriveBigintKey('xyz'));
  });

  test('different fingerprints derive different keys', () => {
    expect(deriveBigintKey('a')).not.toBe(deriveBigintKey('b'));
  });

  test('value sits in postgres bigint range (-2^63 .. 2^63 - 1)', () => {
    const k = deriveBigintKey('range-check');
    const MIN = -(1n << 63n);
    const MAX = (1n << 63n) - 1n;
    expect(k >= MIN).toBe(true);
    expect(k <= MAX).toBe(true);
  });

  test('rejects empty / non-string fingerprint', () => {
    expect(() => deriveBigintKey('')).toThrow(TypeError);
    expect(() => deriveBigintKey(null)).toThrow(TypeError);
    expect(() => deriveBigintKey(42)).toThrow(TypeError);
  });
});

describe('deriveInt4Pair', () => {
  test('returns plain numbers in signed 32-bit range', () => {
    const { key1, key2 } = deriveInt4Pair('xyz');
    expect(typeof key1).toBe('number');
    expect(typeof key2).toBe('number');
    expect(Number.isInteger(key1)).toBe(true);
    expect(Number.isInteger(key2)).toBe(true);
    const I32_MIN = -(2 ** 31);
    const I32_MAX = (2 ** 31) - 1;
    expect(key1 >= I32_MIN && key1 <= I32_MAX).toBe(true);
    expect(key2 >= I32_MIN && key2 <= I32_MAX).toBe(true);
  });

  test('is deterministic', () => {
    expect(deriveInt4Pair('xyz')).toEqual(deriveInt4Pair('xyz'));
  });

  test('the int4 pair concatenates back to the bigint key', () => {
    const fp = 'concat-check';
    const { key1, key2 } = deriveInt4Pair(fp);
    const big = deriveBigintKey(fp);
    // Reconstruct the bigint by treating key1 as the high 32 signed bits
    // and key2 as the low 32 *unsigned* bits, packed back into a 64-bit
    // signed value. This mirrors `bytes.readBigInt64BE(0)`.
    const buf = Buffer.alloc(8);
    buf.writeInt32BE(key1, 0);
    buf.writeInt32BE(key2, 4);
    expect(buf.readBigInt64BE(0)).toBe(big);
  });

  test('rejects empty / non-string fingerprint', () => {
    expect(() => deriveInt4Pair('')).toThrow(TypeError);
    expect(() => deriveInt4Pair(null)).toThrow(TypeError);
  });
});

describe('namespace tag', () => {
  test('PGSERVE_NAMESPACE_TAG is set so unrelated callers cannot collide', () => {
    expect(typeof __testInternals.PGSERVE_NAMESPACE_TAG).toBe('string');
    expect(__testInternals.PGSERVE_NAMESPACE_TAG.length).toBeGreaterThan(0);
  });

  test('namespace-tagged hash differs from raw hash of fingerprint', () => {
    const tagged = __testInternals.sha256Bytes(__testInternals.PGSERVE_NAMESPACE_TAG + 'x');
    const raw = __testInternals.sha256Bytes('x');
    expect(tagged.equals(raw)).toBe(false);
  });
});

describe('buildAdvisoryLockSql', () => {
  test('returns the xact-scoped lock SQL with bigint param', () => {
    const r = buildAdvisoryLockSql('demo');
    expect(r.sql).toBe('SELECT pg_advisory_xact_lock($1::bigint)');
    expect(r.params.length).toBe(1);
    expect(typeof r.params[0]).toBe('bigint');
    expect(r.params[0]).toBe(deriveBigintKey('demo'));
  });
});
