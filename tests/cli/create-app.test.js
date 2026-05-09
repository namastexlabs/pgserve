/**
 * Tests for `pgserve create-app` orchestration verb (G3 of
 * `autopg-distribution-cutover-finalize`).
 *
 * Locks in:
 *   - parseFlags shape (positional <slug> + --port + --json + --help)
 *   - resolvePort fallback
 *   - deepCloneRoots strips Object.freeze wrappers
 *   - help / bad-flag / missing-slug exit codes
 *
 * Postgres-side integration ("does it actually INSERT into autopg_meta
 * and write the cache files") is exercised by
 * tests/integration/verify-slug-rotation.test.sh — that test stands up
 * a real postmaster and runs the verb via the wrapper.
 */

import { test, expect, describe } from 'bun:test';
import { __testInternals, runCreateApp } from '../../src/commands/create-app.js';

const { parseFlags, resolvePort, deepCloneRoots } = __testInternals;

describe('parseFlags', () => {
  test('positional slug captured', () => {
    const o = parseFlags(['demo']);
    expect(o.positional).toEqual(['demo']);
  });

  test('scoped npm-style slug is captured verbatim (sanitization happens later)', () => {
    const o = parseFlags(['@demo/app']);
    expect(o.positional).toEqual(['@demo/app']);
  });

  test('--port <N> in valid range', () => {
    expect(parseFlags(['--port', '15432']).port).toBe(15432);
    expect(parseFlags(['-p', '5433']).port).toBe(5433);
  });

  test('--port rejects out-of-range or non-integer', () => {
    expect(() => parseFlags(['--port', '0'])).toThrow();
    expect(() => parseFlags(['--port', '70000'])).toThrow();
    expect(() => parseFlags(['--port', 'abc'])).toThrow();
  });

  test('--json toggles JSON output', () => {
    expect(parseFlags(['--json']).json).toBe(true);
  });

  test('--help / -h sets help', () => {
    expect(parseFlags(['--help']).help).toBe(true);
    expect(parseFlags(['-h']).help).toBe(true);
  });

  test('slug + flags combine', () => {
    const o = parseFlags(['my-app', '--port', '5433', '--json']);
    expect(o.positional).toEqual(['my-app']);
    expect(o.port).toBe(5433);
    expect(o.json).toBe(true);
  });

  test('unknown flag throws', () => {
    expect(() => parseFlags(['--what'])).toThrow(/unknown flag/);
  });
});

describe('resolvePort', () => {
  test('explicit --port wins', () => {
    expect(resolvePort({ port: 9999 })).toBe(9999);
  });

  test('falls back to a valid integer in [1, 65535]', () => {
    const port = resolvePort({});
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('deepCloneRoots', () => {
  test('strips Object.freeze wrappers', () => {
    const frozen = Object.freeze([
      Object.freeze({ id: 'a', publisher: '@x/y' }),
    ]);
    const cloned = deepCloneRoots(frozen);
    expect(Object.isFrozen(cloned)).toBe(false);
    expect(Object.isFrozen(cloned[0])).toBe(false);
    expect(cloned[0].id).toBe('a');
  });

  test('produces an independent copy (mutation does not affect input)', () => {
    const frozen = Object.freeze([{ id: 'a' }]);
    const cloned = deepCloneRoots(frozen);
    cloned[0].id = 'mutated';
    expect(frozen[0].id).toBe('a');
  });
});

describe('runCreateApp CLI surface', () => {
  test('--help exits 0 without touching postgres', async () => {
    const code = await runCreateApp(['--help']);
    expect(code).toBe(0);
  });

  test('bad flag exits 1', async () => {
    const code = await runCreateApp(['--what']);
    expect(code).toBe(1);
  });

  test('missing slug exits 1', async () => {
    const code = await runCreateApp([]);
    expect(code).toBe(1);
  });

  test('all-symbol slug (sanitizes to empty) exits 1', async () => {
    const code = await runCreateApp(['!!!']);
    expect(code).toBe(1);
  });

  // The "actually registers a slug + writes cache files + INSERTs into
  // autopg_meta" path requires a running postmaster — covered by
  // tests/integration/verify-slug-rotation.test.sh.
});
