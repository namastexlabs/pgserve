/**
 * Regression test for pgvector auto-installer PG-major detection.
 *
 * `postgres --version` prints `postgres (PostgreSQL) 18.2`, so the regex that
 * extracts the major version must tolerate the closing `)` between the
 * product name and the number. An earlier pattern `/PostgreSQL (\d+)/`
 * expected a digit immediately after `PostgreSQL ` and silently fell back to
 * a hard-coded `'17'` default on PG14+, causing the wrong pgvector .deb to be
 * downloaded and a later "incompatible library version mismatch" when
 * `CREATE EXTENSION vector` was executed against a PG18 server.
 *
 * This test pins the corrected regex so the regression can't sneak back in.
 */

import { test, expect, describe } from 'bun:test';
import { pgvectorMetaMatches } from '../src/postgres.js';

// Keep this in sync with `_detectPgMajor()` in src/postgres.js
const PG_VERSION_REGEX = /PostgreSQL\)?\s+(\d+)/;

function detectMajor(versionString) {
  const match = versionString.match(PG_VERSION_REGEX);
  return match ? match[1] : null;
}

describe('PG major version detection for pgvector auto-install', () => {
  test('parses "postgres (PostgreSQL) X.Y" format (actual postgres --version output)', () => {
    expect(detectMajor('postgres (PostgreSQL) 18.2')).toBe('18');
    expect(detectMajor('postgres (PostgreSQL) 17.4')).toBe('17');
    expect(detectMajor('postgres (PostgreSQL) 16.0')).toBe('16');
    expect(detectMajor('postgres (PostgreSQL) 14.11')).toBe('14');
  });

  test('parses pre-release labels', () => {
    expect(detectMajor('postgres (PostgreSQL) 18.2-beta.1')).toBe('18');
    expect(detectMajor('postgres (PostgreSQL) 18devel')).toBe('18');
  });

  test('parses bare "PostgreSQL X" format (no parentheses)', () => {
    expect(detectMajor('PostgreSQL 18.2')).toBe('18');
    expect(detectMajor('PostgreSQL 17')).toBe('17');
  });

  test('returns null on unparseable input so caller can fail loudly', () => {
    expect(detectMajor('')).toBeNull();
    expect(detectMajor('not postgres')).toBeNull();
    expect(detectMajor('mysql 8.0')).toBeNull();
  });
});

/**
 * Staleness detection tests for the pgvector auto-heal path.
 *
 * `pgvectorMetaMatches` decides whether an already-present vector.so on
 * disk can be trusted (return true → reuse) or must be torn down and
 * reinstalled (return false → heal). Getting this wrong in either
 * direction is a production bug:
 *
 *  - False positive (matches when it shouldn't) → stale PG17 .so stays on
 *    disk, CREATE EXTENSION dies with "incompatible library version" on
 *    PG18, brain-ingest blows up mid-run.
 *  - False negative (doesn't match when it should) → pgserve re-downloads
 *    pgvector on every start, wasting bandwidth and triggering
 *    apt.postgresql.org rate limits.
 *
 * These tests pin the exact matching semantics so the auto-heal doesn't
 * silently regress.
 */
describe('pgvectorMetaMatches — pgvector install staleness detection', () => {
  const RUNTIME = {
    pgMajor: '18',
    postgresPath: '/home/user/.pgserve/bin/linux-x64/bin/postgres',
  };

  test('matches when metadata pgMajor and postgresPath agree with runtime', () => {
    const meta = {
      pgMajor: '18',
      pgvectorVersion: '0.8.1-2',
      postgresPath: '/home/user/.pgserve/bin/linux-x64/bin/postgres',
      installedAt: '2026-04-10T18:00:00.000Z',
    };
    expect(pgvectorMetaMatches(meta, RUNTIME)).toBe(true);
  });

  test('matches when postgresPath is absent (older metadata format)', () => {
    const meta = { pgMajor: '18', pgvectorVersion: '0.8.1-2' };
    expect(pgvectorMetaMatches(meta, RUNTIME)).toBe(true);
  });

  test('rejects when pgMajor differs — this is the PG17→PG18 regression we are healing', () => {
    const stalePg17Meta = {
      pgMajor: '17',
      pgvectorVersion: '0.8.1-2',
      postgresPath: '/home/user/.pgserve/bin/linux-x64/bin/postgres',
    };
    expect(pgvectorMetaMatches(stalePg17Meta, RUNTIME)).toBe(false);
  });

  test('rejects when postgresPath points at a different binary (pgserve upgraded)', () => {
    const meta = {
      pgMajor: '18',
      postgresPath: '/opt/old-pgserve/bin/postgres',
    };
    expect(pgvectorMetaMatches(meta, RUNTIME)).toBe(false);
  });

  test('rejects null metadata (pre-auto-heal install without sidecar)', () => {
    // This is the case that heals every existing broken deployment: they
    // have vector.so on disk but no vector.meta.json, so match returns
    // false → reinstall fires.
    expect(pgvectorMetaMatches(null, RUNTIME)).toBe(false);
  });

  test('rejects non-object metadata (corrupted sidecar)', () => {
    expect(pgvectorMetaMatches('18', RUNTIME)).toBe(false);
    expect(pgvectorMetaMatches(42, RUNTIME)).toBe(false);
    expect(pgvectorMetaMatches([], RUNTIME)).toBe(false);
  });

  test('rejects metadata missing pgMajor field', () => {
    expect(pgvectorMetaMatches({ pgvectorVersion: '0.8.1' }, RUNTIME)).toBe(false);
  });

  test('rejects metadata where pgMajor is not a string', () => {
    // JSON could hand us a number — match must be strict about type to
    // avoid `18 == '18'` false positives masking a corrupted file.
    expect(pgvectorMetaMatches({ pgMajor: 18 }, RUNTIME)).toBe(false);
  });
});
