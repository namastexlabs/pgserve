/**
 * Tests for `src/lib/pm2-args.js` — cohort-shared pm2 launch builder.
 *
 * Group 1 of the canonical-pgserve-pm2-supervision wish.
 */

import { test, expect, describe } from 'bun:test';
import path from 'node:path';

import {
  DEFAULT_MAX_MEMORY,
  PM2_HARDENED_DEFAULTS,
  SERVICE_MEMORY_LIMITS,
  buildPm2StartArgs,
  resolveMaxMemory,
} from '../../src/lib/pm2-args.js';

describe('PM2_HARDENED_DEFAULTS', () => {
  test('exports the wish-pinned baseline values', () => {
    expect(PM2_HARDENED_DEFAULTS.maxRestarts).toBe(10);
    expect(PM2_HARDENED_DEFAULTS.restartDelayMs).toBe(5000);
    expect(PM2_HARDENED_DEFAULTS.killTimeoutMs).toBe(20000);
    expect(PM2_HARDENED_DEFAULTS.logDateFormat).toBe('YYYY-MM-DD HH:mm:ss.SSS');
    expect(PM2_HARDENED_DEFAULTS.interpreter).toBe('none');
  });

  test('is frozen — defaults cannot be mutated at runtime', () => {
    expect(Object.isFrozen(PM2_HARDENED_DEFAULTS)).toBe(true);
    expect(() => {
      'use strict';
      PM2_HARDENED_DEFAULTS.maxRestarts = 999;
    }).toThrow();
  });
});

describe('SERVICE_MEMORY_LIMITS', () => {
  test('exports per-service maxMemoryRestart for the canonical four', () => {
    expect(SERVICE_MEMORY_LIMITS['autopg-server']).toBe('2G');
    expect(SERVICE_MEMORY_LIMITS['autopg-ui']).toBe('256M');
    expect(SERVICE_MEMORY_LIMITS['genie-serve']).toBe('2G');
    expect(SERVICE_MEMORY_LIMITS['omni-api']).toBe('2G');
    expect(SERVICE_MEMORY_LIMITS['omni-nats']).toBe('1G');
  });

  test('is frozen', () => {
    expect(Object.isFrozen(SERVICE_MEMORY_LIMITS)).toBe(true);
  });
});

describe('resolveMaxMemory', () => {
  test('caller override wins over per-service map', () => {
    expect(resolveMaxMemory('autopg-ui', '512M')).toBe('512M');
    expect(resolveMaxMemory('omni-nats', '4G')).toBe('4G');
  });

  test('falls back to per-service map when no override', () => {
    expect(resolveMaxMemory('autopg-ui')).toBe('256M');
    expect(resolveMaxMemory('omni-nats')).toBe('1G');
  });

  test('falls back to DEFAULT_MAX_MEMORY for unknown services', () => {
    expect(resolveMaxMemory('some-other-service')).toBe(DEFAULT_MAX_MEMORY);
    expect(resolveMaxMemory('some-other-service')).toBe('2G');
  });
});

describe('buildPm2StartArgs', () => {
  const baseOpts = {
    scriptPath: '/usr/local/bin/genie',
    logsDir: '/home/test/.genie/logs',
  };

  test('returns the canonical hardened argv for genie-serve', () => {
    const argv = buildPm2StartArgs('genie-serve', {
      ...baseOpts,
      scriptArgs: ['serve', 'start', '--headless', '--no-tui', '--no-interactive'],
    });

    expect(argv[0]).toBe('start');
    expect(argv[1]).toBe('/usr/local/bin/genie');

    // Spot-check the hardening flags are present with the wish-pinned values.
    const flagPair = (flag) => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : null;
    };
    expect(flagPair('--name')).toBe('genie-serve');
    expect(flagPair('--interpreter')).toBe('none');
    expect(flagPair('--max-restarts')).toBe('10');
    expect(flagPair('--restart-delay')).toBe('5000');
    expect(flagPair('--max-memory-restart')).toBe('2G');
    expect(flagPair('--kill-timeout')).toBe('20000');
    expect(flagPair('--log-date-format')).toBe('YYYY-MM-DD HH:mm:ss.SSS');
    expect(flagPair('--output')).toBe(path.join('/home/test/.genie/logs', 'genie-serve-out.log'));
    expect(flagPair('--error')).toBe(path.join('/home/test/.genie/logs', 'genie-serve-error.log'));

    // The script-arg portion comes after `--` and is forwarded verbatim.
    const dashDash = argv.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(argv.slice(dashDash + 1)).toEqual([
      'serve', 'start', '--headless', '--no-tui', '--no-interactive',
    ]);
  });

  test('omni-nats picks up the 1G ceiling per the wish', () => {
    const argv = buildPm2StartArgs('omni-nats', baseOpts);
    const i = argv.indexOf('--max-memory-restart');
    expect(argv[i + 1]).toBe('1G');
  });

  test('autopg-ui picks up the 256M ceiling per the wish', () => {
    const argv = buildPm2StartArgs('autopg-ui', baseOpts);
    const i = argv.indexOf('--max-memory-restart');
    expect(argv[i + 1]).toBe('256M');
  });

  test('opts.maxMemoryRestart override wins over the per-service map', () => {
    const argv = buildPm2StartArgs('autopg-ui', { ...baseOpts, maxMemoryRestart: '1G' });
    const i = argv.indexOf('--max-memory-restart');
    expect(argv[i + 1]).toBe('1G');
  });

  test('opts.overrides.maxRestarts replaces the default budget', () => {
    const argv = buildPm2StartArgs('genie-serve', {
      ...baseOpts,
      overrides: { maxRestarts: 50 },
    });
    const i = argv.indexOf('--max-restarts');
    expect(argv[i + 1]).toBe('50');
  });

  test('omits the `--` separator when scriptArgs is empty or absent', () => {
    const argv = buildPm2StartArgs('autopg-ui', baseOpts);
    expect(argv).not.toContain('--');

    const argvEmpty = buildPm2StartArgs('autopg-ui', { ...baseOpts, scriptArgs: [] });
    expect(argvEmpty).not.toContain('--');
  });

  test('rejects empty / non-string serviceName', () => {
    expect(() => buildPm2StartArgs('', baseOpts)).toThrow(/serviceName/);
    expect(() => buildPm2StartArgs(null, baseOpts)).toThrow(/serviceName/);
    expect(() => buildPm2StartArgs(123, baseOpts)).toThrow(/serviceName/);
  });

  test('rejects serviceName with shell-meta characters', () => {
    expect(() => buildPm2StartArgs('foo;bar', baseOpts)).toThrow(/serviceName/);
    expect(() => buildPm2StartArgs('foo bar', baseOpts)).toThrow(/serviceName/);
    expect(() => buildPm2StartArgs('foo$bar', baseOpts)).toThrow(/serviceName/);
  });

  test('rejects missing scriptPath / logsDir', () => {
    expect(() => buildPm2StartArgs('genie-serve', {})).toThrow(/scriptPath/);
    expect(() => buildPm2StartArgs('genie-serve', { scriptPath: '/x' })).toThrow(/logsDir/);
  });
});
