/**
 * Tests for the pure orphan classifier (singleton G3 gc foundation).
 */

import { test, expect, describe } from 'bun:test';
import {
  classifyRow,
  classifyOrphans,
  __testInternals,
} from '../../src/gc/orphan-detection.js';

const { DEFAULT_STALE_AFTER_MS, asTime } = __testInternals;

const NOW = new Date('2026-05-08T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function ctx(overrides = {}) {
  return {
    existingDbs: new Set(),
    activeDbs: new Set(),
    pathExists: () => true,
    now: NOW,
    staleAfterMs: 30 * DAY,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    fingerprint: 'fp1',
    database_name: 'pgserve_x_aaaa',
    role_name: 'pgserve_x_aaaa_role',
    source_path: '/tmp/some-consumer',
    last_used_at: '2026-05-08T11:00:00.000Z',
    ...overrides,
  };
}

describe('classifyRow — orphan signals', () => {
  test('missing_db when database is not in pg_database', () => {
    const r = classifyRow(row(), ctx({ existingDbs: new Set() }));
    expect(r.reason).toBe('missing_db');
  });

  test('missing_path when source_path no longer exists on disk', () => {
    const r = classifyRow(row(), ctx({
      existingDbs: new Set(['pgserve_x_aaaa']),
      pathExists: () => false,
    }));
    expect(r.reason).toBe('missing_path');
  });

  test('source_path missing → no missing_path signal', () => {
    const r = classifyRow(
      row({ source_path: undefined }),
      ctx({
        existingDbs: new Set(['pgserve_x_aaaa']),
        pathExists: () => false, // never called for this case
      }),
    );
    expect(r.reason).not.toBe('missing_path');
  });

  test('idle_stale when last_used_at past threshold and no active connections', () => {
    const r = classifyRow(
      row({ last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString() }),
      ctx({
        existingDbs: new Set(['pgserve_x_aaaa']),
        activeDbs: new Set(),
        staleAfterMs: 30 * DAY,
      }),
    );
    expect(r.reason).toBe('idle_stale');
    expect(r.detail).toMatch(/60d/);
  });
});

describe('classifyRow — retention signals', () => {
  test('active wins even when last_used_at is ancient', () => {
    const r = classifyRow(
      row({ last_used_at: '2020-01-01T00:00:00.000Z' }),
      ctx({
        existingDbs: new Set(['pgserve_x_aaaa']),
        activeDbs: new Set(['pgserve_x_aaaa']),
      }),
    );
    expect(r.reason).toBe('active');
  });

  test('recent when within the staleness window', () => {
    const r = classifyRow(
      row({ last_used_at: new Date(NOW.getTime() - 5 * DAY).toISOString() }),
      ctx({
        existingDbs: new Set(['pgserve_x_aaaa']),
        staleAfterMs: 30 * DAY,
      }),
    );
    expect(r.reason).toBe('recent');
  });

  test('unknown_meta when last_used_at is missing/unparseable — never gc', () => {
    const r = classifyRow(
      row({ last_used_at: undefined }),
      ctx({ existingDbs: new Set(['pgserve_x_aaaa']) }),
    );
    expect(r.reason).toBe('unknown_meta');
    const r2 = classifyRow(
      row({ last_used_at: 'not-a-date' }),
      ctx({ existingDbs: new Set(['pgserve_x_aaaa']) }),
    );
    expect(r2.reason).toBe('unknown_meta');
  });
});

describe('classifyRow — input validation', () => {
  test('throws TypeError on missing or empty database_name', () => {
    expect(() => classifyRow({}, ctx())).toThrow(TypeError);
    expect(() => classifyRow({ database_name: '' }, ctx())).toThrow(TypeError);
    expect(() => classifyRow(null, ctx())).toThrow(TypeError);
  });
});

describe('classifyOrphans — partition shape', () => {
  test('split partitions are exhaustive and disjoint', () => {
    const rows = [
      row({ fingerprint: 'a', database_name: 'db_a', source_path: '/a' }), // missing_db (not in existingDbs)
      row({ fingerprint: 'b', database_name: 'db_b', source_path: '/b' }), // active
      row({ fingerprint: 'c', database_name: 'db_c', source_path: '/c', last_used_at: new Date(NOW.getTime() - 100 * DAY).toISOString() }), // idle_stale
      row({ fingerprint: 'd', database_name: 'db_d', source_path: '/d-gone' }), // missing_path
      row({ fingerprint: 'e', database_name: 'db_e', source_path: '/e', last_used_at: undefined }), // unknown_meta
    ];
    const result = classifyOrphans({
      metaRows: rows,
      existingDbs: new Set(['db_b', 'db_c', 'db_d', 'db_e']),
      activeDbs: new Set(['db_b']),
      pathExists: (p) => p !== '/d-gone',
      now: NOW,
      staleAfterMs: 30 * DAY,
    });
    expect(result.orphans.length + result.retained.length).toBe(rows.length);
    const orphanReasons = result.orphans.map((o) => o.reason).sort();
    const retainedReasons = result.retained.map((r) => r.reason).sort();
    expect(orphanReasons).toEqual(['idle_stale', 'missing_db', 'missing_path']);
    expect(retainedReasons).toEqual(['active', 'unknown_meta']);
  });

  test('default staleAfterMs is the documented 30d', () => {
    expect(DEFAULT_STALE_AFTER_MS).toBe(30 * DAY);
  });

  test('empty input → empty partitions', () => {
    const r = classifyOrphans({});
    expect(r.orphans).toEqual([]);
    expect(r.retained).toEqual([]);
  });
});

describe('asTime', () => {
  test('handles strings, Dates, numbers, missing', () => {
    expect(asTime(undefined)).toBeNull();
    expect(asTime(null)).toBeNull();
    expect(asTime('not-a-date')).toBeNull();
    expect(asTime('2026-05-08T00:00:00Z')).toBe(Date.parse('2026-05-08T00:00:00Z'));
    expect(asTime(new Date('2026-05-08T00:00:00Z'))).toBe(Date.parse('2026-05-08T00:00:00Z'));
    expect(asTime(1000000)).toBe(1000000);
  });
});
