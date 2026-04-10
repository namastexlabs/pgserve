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

// Keep this in sync with `ensurePgvectorFiles()` in src/postgres.js
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
