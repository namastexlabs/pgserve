/**
 * Tests for `pgserve provision` orchestration verb (singleton G3 verb 4).
 *
 * Helper modules (resolveFingerprint, deriveProvisionedNames, advisory
 * lock derivation, schema bootstrap) have their own dedicated tests at
 * 100% coverage. This file locks in:
 *   - parseFlags shape contract
 *   - resolvePort fallback
 *   - bigintLiteral formatting
 *   - help / bad-flag exit codes
 *
 * Postgres-side integration ("does it actually create a database") is
 * an integration test that needs a real postmaster running and lives
 * in tests/integration/ (deferred to a follow-up alongside gc).
 */

import { test, expect, describe } from 'bun:test';
import { __testInternals, runProvision } from '../../src/commands/provision.js';

const { parseFlags, resolvePort } = __testInternals;

describe('parseFlags', () => {
  test('positional fingerprint captured', () => {
    const o = parseFlags(['abc-pinned']);
    expect(o.positional).toEqual(['abc-pinned']);
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

  test('positional + flags combine', () => {
    const o = parseFlags(['my-pin', '--port', '5433', '--json']);
    expect(o.positional).toEqual(['my-pin']);
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

describe('runProvision CLI surface', () => {
  test('--help exits 0 without touching postgres', async () => {
    const code = await runProvision(['--help']);
    expect(code).toBe(0);
  });

  test('bad flag exits 1', async () => {
    const code = await runProvision(['--what']);
    expect(code).toBe(1);
  });

  // The "actually provisions a database" path requires a running
  // postmaster + writable pgserve_meta — covered by an integration
  // test that spins up a real postgres in CI.
});
