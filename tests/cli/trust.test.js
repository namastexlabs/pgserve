/**
 * Tests for the `pgserve trust` CLI flag parser.
 *
 * Full subverb behavior (add/remove/list) is exercised by
 * tests/cosign/trust-store.test.js against the underlying module so we do
 * not need to spawn child processes here. This file just locks in the
 * argv-shape contract.
 */

import { test, expect, describe } from 'bun:test';
import { __testInternals, runTrust } from '../../src/commands/trust.js';

const { parseFlags } = __testInternals;

describe('parseFlags', () => {
  test('--json toggles json output', () => {
    expect(parseFlags(['list', '--json']).json).toBe(true);
  });

  test('--issuer <url> consumes one positional', () => {
    const o = parseFlags(['add', 'fork', '--issuer', 'https://x', '--identity-regexp', '.+']);
    expect(o.positional).toEqual(['add', 'fork']);
    expect(o.flags.issuer).toBe('https://x');
    expect(o.flags['identity-regexp']).toBe('.+');
  });

  test('value-less flag (--help) sets boolean true', () => {
    const o = parseFlags(['--help']);
    expect(o.flags.help).toBe(true);
  });

  test('two consecutive --flags treats first as boolean', () => {
    const o = parseFlags(['--json', '--help']);
    expect(o.json).toBe(true);
    expect(o.flags.help).toBe(true);
  });
});

describe('runTrust dispatch', () => {
  test('no args prints USAGE and exits non-zero', async () => {
    const code = await runTrust([]);
    expect(code).toBe(1);
  });

  test('--help exits 0', async () => {
    const code = await runTrust(['--help']);
    expect(code).toBe(0);
  });

  test('unknown subverb exits 1', async () => {
    const code = await runTrust(['nope', '--json']);
    expect(code).toBe(1);
  });

  test('add without id exits 1', async () => {
    const code = await runTrust(['add', '--json']);
    expect(code).toBe(1);
  });

  test('add without --issuer exits 1', async () => {
    const code = await runTrust(['add', 'fork', '--identity-regexp', '.+', '--json']);
    expect(code).toBe(1);
  });

  test('remove without id exits 1', async () => {
    const code = await runTrust(['remove', '--json']);
    expect(code).toBe(1);
  });
});
