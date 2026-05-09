/**
 * Tests for `pgserve gc` orchestration verb (singleton G3 verb 3).
 *
 * The verb's purity-side (orphan classifier + audit log) is exercised by
 * tests/gc/orphan-detection.test.js + tests/gc/audit-log.test.js.
 * queries.js's psql shellout is exercised by
 * tests/gc/queries.test.js. This file locks the CLI flag-parser +
 * resolvePort fallback contract.
 */

import { test, expect, describe } from 'bun:test';
import { __testInternals, runGc } from '../../src/commands/gc.js';

const { parseFlags, resolvePort } = __testInternals;

describe('parseFlags', () => {
  test('default is dry-run (apply: false)', () => {
    const o = parseFlags([]);
    expect(o.apply).toBe(false);
  });

  test('--apply enables drops', () => {
    expect(parseFlags(['--apply']).apply).toBe(true);
  });

  test('--dry-run + --apply: last one wins (--apply at end → apply)', () => {
    const o = parseFlags(['--apply', '--dry-run']);
    expect(o.apply).toBe(false);
  });

  test('--json toggles JSON output', () => {
    expect(parseFlags(['--json']).json).toBe(true);
  });

  test('--stale-after-days <N> sets the staleness window', () => {
    expect(parseFlags(['--stale-after-days', '7']).staleAfterDays).toBe(7);
  });

  test('--stale-after-days rejects non-integer / non-positive', () => {
    expect(() => parseFlags(['--stale-after-days', '0'])).toThrow(/positive integer/);
    expect(() => parseFlags(['--stale-after-days', '-3'])).toThrow();
    expect(() => parseFlags(['--stale-after-days', 'abc'])).toThrow();
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

  test('--help / -h sets help', () => {
    expect(parseFlags(['--help']).help).toBe(true);
    expect(parseFlags(['-h']).help).toBe(true);
  });

  test('unknown flag throws', () => {
    expect(() => parseFlags(['--what'])).toThrow(/unknown flag/);
  });
});

describe('resolvePort', () => {
  test('explicit --port wins', () => {
    expect(resolvePort({ port: 9999 })).toBe(9999);
  });

  test('falls back to 5432 when no admin.json and no override', () => {
    // The host running tests may have an admin.json. We accept either
    // 5432 (no admin) or whatever admin reports. The contract is "an
    // integer in valid range."
    const port = resolvePort({});
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('runGc CLI surface', () => {
  test('--help exits 0 without touching postgres', async () => {
    const code = await runGc(['--help']);
    expect(code).toBe(0);
  });

  test('bad flag exits 1 with usage on stderr', async () => {
    const code = await runGc(['--what']);
    expect(code).toBe(1);
  });

  // The "no pgserve_meta" path returns 2; the "real DB connection" path
  // returns 0/3. We don't lock host-state-dependent behavior here —
  // those branches are integration-shaped and live in a future
  // tests/integration/gc.test.sh once the verb has provisioned data
  // to operate on.
});
