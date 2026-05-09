/**
 * Tests for database + role naming (singleton G3 provision foundation).
 */

import { test, expect, describe } from 'bun:test';
import {
  sanitizeSlug,
  deriveProvisionedNames,
  __testInternals,
} from '../../src/provision/db-naming.js';

const { POSTGRES_MAX_IDENTIFIER, PREFIX, FINGERPRINT_HEX_LEN, ROLE_SUFFIX } = __testInternals;

const FP = 'a'.repeat(64); // sha256-hex shape

describe('sanitizeSlug', () => {
  test('lowercases, replaces non-[a-z0-9] runs with single underscore', () => {
    expect(sanitizeSlug('@Automagik/Genie')).toBe('automagik_genie');
    expect(sanitizeSlug('Hello   World')).toBe('hello_world');
    expect(sanitizeSlug('a/b/c')).toBe('a_b_c');
  });

  test('trims leading and trailing underscores', () => {
    expect(sanitizeSlug('@@hello@@')).toBe('hello');
  });

  test('returns empty for non-string or empty input', () => {
    expect(sanitizeSlug(null)).toBe('');
    expect(sanitizeSlug(undefined)).toBe('');
    expect(sanitizeSlug('')).toBe('');
    expect(sanitizeSlug(123)).toBe('');
  });
});

describe('deriveProvisionedNames — happy path', () => {
  test('builds pgserve_<slug>_<fp12> and matching _role', () => {
    const r = deriveProvisionedNames({
      fingerprint: FP,
      publisher: '@automagik/genie',
    });
    expect(r.databaseName).toBe('pgserve_automagik_genie_aaaaaaaaaaaa');
    expect(r.roleName).toBe('pgserve_automagik_genie_aaaaaaaaaaaa_role');
    expect(r.slug).toBe('automagik_genie');
    expect(r.fingerprintHex).toBe('aaaaaaaaaaaa');
  });

  test('database name includes the literal pgserve_ prefix', () => {
    const r = deriveProvisionedNames({ fingerprint: FP, publisher: 'x' });
    expect(r.databaseName.startsWith(PREFIX)).toBe(true);
    expect(r.roleName.startsWith(PREFIX)).toBe(true);
  });

  test('role name ends with _role suffix', () => {
    const r = deriveProvisionedNames({ fingerprint: FP, publisher: 'x' });
    expect(r.roleName.endsWith(ROLE_SUFFIX)).toBe(true);
  });

  test('uses first 12 hex chars of fingerprint', () => {
    const r = deriveProvisionedNames({ fingerprint: FP, publisher: 'x' });
    expect(r.fingerprintHex.length).toBe(FINGERPRINT_HEX_LEN);
  });
});

describe('deriveProvisionedNames — length safety', () => {
  test('extremely long publisher truncates so role still ≤63 chars', () => {
    const r = deriveProvisionedNames({
      fingerprint: FP,
      publisher: 'a'.repeat(200),
    });
    expect(r.databaseName.length).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER);
    expect(r.roleName.length).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER);
  });

  test('database + role share the same slug after truncation (operator UX)', () => {
    const r = deriveProvisionedNames({
      fingerprint: FP,
      publisher: 'this-is-a-very-long-publisher-name-that-definitely-overflows',
    });
    // slug appears unchanged in both: extract it by stripping prefix and
    // the trailing _<fp12>(_role)? segment.
    const dbSlug = r.databaseName.slice(PREFIX.length, r.databaseName.length - 1 - FINGERPRINT_HEX_LEN);
    const roleSlug = r.roleName.slice(PREFIX.length, r.roleName.length - ROLE_SUFFIX.length - 1 - FINGERPRINT_HEX_LEN);
    expect(dbSlug).toBe(roleSlug);
  });
});

describe('deriveProvisionedNames — empty publisher', () => {
  test('omits the slug section when publisher is empty', () => {
    const r = deriveProvisionedNames({ fingerprint: FP, publisher: '' });
    expect(r.databaseName).toBe(`${PREFIX}aaaaaaaaaaaa`);
    expect(r.roleName).toBe(`${PREFIX}aaaaaaaaaaaa${ROLE_SUFFIX}`);
    expect(r.slug).toBe('');
  });

  test('omits the slug section when publisher sanitizes to empty', () => {
    const r = deriveProvisionedNames({ fingerprint: FP, publisher: '@@@@@' });
    expect(r.databaseName).toBe(`${PREFIX}aaaaaaaaaaaa`);
    expect(r.slug).toBe('');
  });
});

describe('deriveProvisionedNames — pinned (non-hex) fingerprints', () => {
  test('non-hex fingerprint is sanitized into the hex-segment slot', () => {
    const r = deriveProvisionedNames({
      fingerprint: 'manual-pin-2026!',
      publisher: 'pkg',
    });
    // fingerprintHex slot is sanitizeSlug(fp).slice(0, 12)
    // sanitize('manual-pin-2026!') = 'manual_pin_2026'
    expect(r.fingerprintHex).toBe('manual_pin_2');
    expect(r.databaseName).toBe('pgserve_pkg_manual_pin_2');
  });

  test('throws when the fingerprint produces an empty hex segment', () => {
    expect(() => deriveProvisionedNames({ fingerprint: '!!!', publisher: 'pkg' }))
      .toThrow(/empty hex segment/);
  });
});

describe('deriveProvisionedNames — input validation', () => {
  test('rejects empty or non-string fingerprint', () => {
    expect(() => deriveProvisionedNames({ fingerprint: '', publisher: 'pkg' })).toThrow(TypeError);
    expect(() => deriveProvisionedNames({ fingerprint: null, publisher: 'pkg' })).toThrow(TypeError);
    expect(() => deriveProvisionedNames({ fingerprint: 0, publisher: 'pkg' })).toThrow(TypeError);
  });

  test('called with no argument throws the documented TypeError (PR #89 review fix)', () => {
    // Without the `= {}` default, destructuring `undefined` throws a
    // generic "Cannot destructure" error before our explicit
    // fingerprint check runs. The default makes the failure mode
    // consistent with the other rejection paths above.
    expect(() => deriveProvisionedNames()).toThrow(TypeError);
    expect(() => deriveProvisionedNames()).toThrow(/fingerprint must be a non-empty string/);
  });
});

describe('determinism', () => {
  test('same inputs produce identical names across repeated calls', () => {
    const a = deriveProvisionedNames({ fingerprint: FP, publisher: 'x' });
    const b = deriveProvisionedNames({ fingerprint: FP, publisher: 'x' });
    expect(a).toEqual(b);
  });
});
