/**
 * `pg_advisory_lock` key derivation for `pgserve provision`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * The wish locks the concurrency story: 10 simultaneous `pgserve
 * provision <fingerprint>` calls must produce exactly 1 database. The
 * server-side coordination is `pg_advisory_lock(key)`; this module
 * derives the integer key from a fingerprint string deterministically.
 *
 * Why two forms:
 *   - `pg_advisory_lock(bigint)`        — single 64-bit key
 *   - `pg_advisory_lock(int4, int4)`    — two 32-bit keys (older
 *     postgres major versions on hosts the cohort still supports)
 *
 * Both are derived from the same sha256 of the fingerprint, so two
 * provision processes against the same fingerprint will always pick
 * the same lock regardless of which advisory-lock variant they call.
 *
 * Key derivation:
 *   - sha256(fingerprint) → 32 bytes
 *   - bigint key:  reinterpret the first 8 bytes as a signed 64-bit
 *                  integer, big-endian. The bigint form is what we
 *                  recommend; the int4 form is provided for parity with
 *                  callers that need it.
 *   - int4 pair:   high 32 bits → key1, low 32 bits → key2 (both
 *                  signed). This matches postgres's two-arg overload.
 *
 * Pure function: no postgres I/O, no network, no globals.
 */

import crypto from 'node:crypto';

const PGSERVE_NAMESPACE_TAG = 'pgserve-provision-v1:';

function sha256Bytes(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

/**
 * Derive the bigint advisory-lock key from a fingerprint string.
 * Returned as a JS BigInt; postgres bigint accepts any signed 64-bit
 * integer (range: -2^63 .. 2^63 - 1).
 * @returns {BigInt}
 */
export function deriveBigintKey(fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('deriveBigintKey: fingerprint must be a non-empty string');
  }
  const bytes = sha256Bytes(PGSERVE_NAMESPACE_TAG + fingerprint);
  // Read first 8 bytes big-endian, signed.
  const key = bytes.readBigInt64BE(0);
  return key;
}

/**
 * Derive the (int4, int4) advisory-lock key pair. Returns plain Numbers
 * in the signed 32-bit range so the caller can pass them straight to
 * pg-cstring/pg-promise without BigInt coercion plumbing.
 * @returns {{ key1: number, key2: number }}
 */
export function deriveInt4Pair(fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('deriveInt4Pair: fingerprint must be a non-empty string');
  }
  const bytes = sha256Bytes(PGSERVE_NAMESPACE_TAG + fingerprint);
  // High 32 bits → key1; low 32 bits → key2; both signed.
  const key1 = bytes.readInt32BE(0);
  const key2 = bytes.readInt32BE(4);
  return { key1, key2 };
}

/**
 * Convenience: returns the SQL fragment that acquires the lock with
 * pg_advisory_xact_lock. pgserve provision wraps a transaction around
 * its CREATE DATABASE / CREATE ROLE / INSERT, and xact-scoped locks
 * release automatically when that transaction commits or rolls back —
 * no risk of a dangling session-scoped lock surviving a crashed
 * provision.
 *
 * Returns: `{ sql: '...', params: [BigInt] }`
 */
export function buildAdvisoryLockSql(fingerprint) {
  const key = deriveBigintKey(fingerprint);
  return {
    sql: 'SELECT pg_advisory_xact_lock($1::bigint)',
    params: [key],
  };
}

export const __testInternals = Object.freeze({ sha256Bytes, PGSERVE_NAMESPACE_TAG });
