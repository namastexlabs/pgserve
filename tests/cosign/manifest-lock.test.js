/**
 * Tests for the locked-roots loader (G3 D4a — autopg-distribution-cutover-finalize).
 *
 * The loader's happy path is a psql shellout, exercised by the integration
 * test at tests/integration/verify-slug-rotation.test.sh. The unit tests
 * here cover the input-validation branches that DON'T need postgres —
 * empty slug, all-symbol slug, the structured error shape callers rely
 * on for exit-code mapping.
 */

import { test, expect, describe } from 'bun:test';
import { loadLockedRoots } from '../../src/cosign/locked-roots.js';

describe('loadLockedRoots — pre-postgres validation', () => {
  test('throws TypeError on empty slug', () => {
    expect(() => loadLockedRoots({ slug: '' })).toThrow(TypeError);
    expect(() => loadLockedRoots({ slug: '   ' })).toThrow(TypeError);
  });

  test('throws TypeError on missing slug', () => {
    expect(() => loadLockedRoots({})).toThrow(TypeError);
    expect(() => loadLockedRoots()).toThrow(TypeError);
  });

  test('throws TypeError on non-string slug', () => {
    expect(() => loadLockedRoots({ slug: 123 })).toThrow(TypeError);
    expect(() => loadLockedRoots({ slug: null })).toThrow(TypeError);
  });

  test('throws structured error with code EAUTOPGSLUGUNKNOWN on all-symbol slug', () => {
    let caught;
    try {
      loadLockedRoots({ slug: '!!!' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('EAUTOPGSLUGUNKNOWN');
    expect(caught.message).toMatch(/sanitizes to empty/);
  });
});
