/**
 * Tests for src/cli/install.js — autopg install binary subcommand
 * (Group 11, autopg-distribution-cutover wish).
 *
 * Strategy: drive `install()` directly with injected ctx so the unit suite
 * never touches a real pm2, daemon, or PATH. Every external side-effect
 * (pm2 spawn, daemon health probe, upgrade migration) lands in a stub we
 * inspect after the run. The filesystem side-effects DO happen, but
 * against a tempdir we own, with HOME redirected so rc-file appends and
 * symlinks land in scratch space.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  install,
  parseArgs,
  writeCanonicalConfig,
  getConfigDir,
  getLocalBinDir,
  getCompletionsDir,
  getRcFiles,
  getConfigPath,
  PM2_PROCESS_NAME,
  DEFAULT_PORT,
  DEFAULT_CHANNEL,
  USAGE,
  _internals,
} from '../../src/cli/install.js';

let tmpHome;
let env;
let stdout;
let stderr;
let pm2Calls;
let upgradeCalls;
let pm2State;

function captureStream() {
  const chunks = [];
  return {
    write: (s) => { chunks.push(String(s)); return true; },
    text: () => chunks.join(''),
  };
}

function makeCtx({ binaryPath, version = '2.260503.1', overrides = {} } = {}) {
  return {
    stdout,
    stderr,
    env,
    binaryPath: binaryPath || path.join(tmpHome, 'install', '2.260503.1', 'autopg', 'autopg'),
    version,
    pm2IsAvailable: () => true,
    pm2GetProcess: () => pm2State.process,
    pm2Start: (opts) => {
      pm2Calls.push(opts);
      pm2State.process = {
        name: PM2_PROCESS_NAME,
        pm2_env: { status: 'online' },
      };
      return { status: 0, stderr: '' };
    },
    runUpgrade: async (opts) => {
      upgradeCalls.push(opts);
      return { ran: true, ok: true };
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-install-test-'));
  // Pre-create a fake binary so the symlink target exists.
  const installDir = path.join(tmpHome, 'install', '2.260503.1', 'autopg');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'autopg'), '#!/bin/sh\necho stub\n', { mode: 0o755 });

  env = {
    HOME: tmpHome,
    AUTOPG_CONFIG_DIR: path.join(tmpHome, '.autopg'),
    PATH: process.env.PATH,
  };
  stdout = captureStream();
  stderr = captureStream();
  pm2Calls = [];
  upgradeCalls = [];
  pm2State = { process: null };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('default: not non-interactive, not help', () => {
    expect(parseArgs([])).toEqual({ nonInteractive: false, help: false });
  });

  test('--non-interactive sets the flag', () => {
    expect(parseArgs(['--non-interactive']).nonInteractive).toBe(true);
  });

  test('--help / -h sets the help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  test('unknown flag throws', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag "--bogus"/);
  });
});

describe('--help', () => {
  test('prints usage and exits 0 without touching anything', async () => {
    const ctx = makeCtx();
    const code = await install(['--help'], ctx);
    expect(code).toBe(0);
    expect(stdout.text()).toBe(USAGE);
    expect(pm2Calls).toEqual([]);
    expect(fs.existsSync(getConfigPath(env))).toBe(false);
  });
});

describe('canonical config', () => {
  test('writes ~/.autopg/config.json with channel + port + binaryPath', async () => {
    const ctx = makeCtx();
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(env), 'utf8'));
    expect(cfg.channel).toBe(DEFAULT_CHANNEL);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.binaryPath).toBe(ctx.binaryPath);
    expect(cfg.installDir).toBe(path.dirname(ctx.binaryPath));
    expect(cfg.version).toBe('2.260503.1');
    expect(cfg.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('preserves existing port and channel on re-run', async () => {
    fs.mkdirSync(path.join(tmpHome, '.autopg'), { recursive: true });
    fs.writeFileSync(getConfigPath(env), JSON.stringify({
      channel: 'beta',
      port: 8442,
      registeredAt: '2026-01-01T00:00:00.000Z',
    }), { mode: 0o644 });

    await install(['--non-interactive'], makeCtx());
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(env), 'utf8'));
    expect(cfg.channel).toBe('beta');
    expect(cfg.port).toBe(8442);
    expect(cfg.registeredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('writeCanonicalConfig is idempotent for identical input', () => {
    const binaryPath = path.join(tmpHome, '.autopg', 'install', '2.260503.1', 'autopg', 'autopg');
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const r1 = writeCanonicalConfig({ binaryPath, version: '2.260503.1', env });
    expect(r1.wrote).toBe(true);
    const r2 = writeCanonicalConfig({ binaryPath, version: '2.260503.1', env });
    expect(r2.wrote).toBe(false);
  });
});

describe('~/.local/bin symlink', () => {
  test('creates the symlink pointing at the binary', async () => {
    const ctx = makeCtx();
    await install(['--non-interactive'], ctx);
    const linkPath = path.join(getLocalBinDir(env), 'autopg');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(ctx.binaryPath);
  });

  test('idempotent: re-running with same target leaves link untouched', async () => {
    const ctx = makeCtx();
    await install(['--non-interactive'], ctx);
    const linkPath = path.join(getLocalBinDir(env), 'autopg');
    const inode1 = fs.lstatSync(linkPath).ino;
    await install(['--non-interactive'], ctx);
    const inode2 = fs.lstatSync(linkPath).ino;
    expect(inode2).toBe(inode1);
    expect(fs.readlinkSync(linkPath)).toBe(ctx.binaryPath);
  });

  test('replaces a stale regular file at the link path', async () => {
    fs.mkdirSync(getLocalBinDir(env), { recursive: true });
    const linkPath = path.join(getLocalBinDir(env), 'autopg');
    fs.writeFileSync(linkPath, '#!/bin/sh\necho stale\n', { mode: 0o755 });
    expect(fs.lstatSync(linkPath).isFile()).toBe(true);

    const ctx = makeCtx();
    await install(['--non-interactive'], ctx);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(ctx.binaryPath);
  });

  test('replaces a symlink pointing somewhere else', async () => {
    fs.mkdirSync(getLocalBinDir(env), { recursive: true });
    const linkPath = path.join(getLocalBinDir(env), 'autopg');
    fs.symlinkSync('/nowhere/old/autopg', linkPath);

    const ctx = makeCtx();
    await install(['--non-interactive'], ctx);
    expect(fs.readlinkSync(linkPath)).toBe(ctx.binaryPath);
  });
});

describe('rc-file PATH wiring', () => {
  test('appends to ~/.bashrc and ~/.zshrc when neither exists', async () => {
    await install(['--non-interactive'], makeCtx());
    for (const rc of getRcFiles(env)) {
      const body = fs.readFileSync(rc, 'utf8');
      expect(body).toContain(_internals.PATH_LINE);
      expect(body).toContain(_internals.PATH_MARKER);
    }
  });

  test('appends to existing rc-file without disturbing prior content', async () => {
    fs.writeFileSync(getRcFiles(env)[0], '# my custom rc\nexport FOO=bar\n');
    await install(['--non-interactive'], makeCtx());
    const body = fs.readFileSync(getRcFiles(env)[0], 'utf8');
    expect(body).toContain('# my custom rc');
    expect(body).toContain('export FOO=bar');
    expect(body).toContain(_internals.PATH_LINE);
  });

  test('idempotent — second install does not duplicate the export line', async () => {
    await install(['--non-interactive'], makeCtx());
    const body1 = fs.readFileSync(getRcFiles(env)[0], 'utf8');
    await install(['--non-interactive'], makeCtx());
    const body2 = fs.readFileSync(getRcFiles(env)[0], 'utf8');
    expect(body2).toBe(body1);
    const occurrences = body2.match(new RegExp(_internals.PATH_LINE.replace(/[\$\.\/\(\)\*\+\?\\]/g, '\\$&'), 'g'));
    expect(occurrences?.length).toBe(1);
  });

  test('respects an existing matching export PATH line (no marker added)', async () => {
    fs.writeFileSync(getRcFiles(env)[0], `# user wrote this themselves\n${_internals.PATH_LINE}\n`);
    await install(['--non-interactive'], makeCtx());
    const body = fs.readFileSync(getRcFiles(env)[0], 'utf8');
    const occurrences = body.match(new RegExp(_internals.PATH_LINE.replace(/[\$\.\/\(\)\*\+\?\\]/g, '\\$&'), 'g'));
    expect(occurrences?.length).toBe(1);
    expect(body).not.toContain(_internals.PATH_MARKER);
  });
});

describe('completions', () => {
  test('writes bash + zsh completions to ~/.local/share/autopg/completions/', async () => {
    await install(['--non-interactive'], makeCtx());
    const dir = getCompletionsDir(env);
    const bash = fs.readFileSync(path.join(dir, 'autopg.bash'), 'utf8');
    const zsh = fs.readFileSync(path.join(dir, '_autopg'), 'utf8');
    expect(bash).toContain('complete -F _autopg autopg');
    expect(bash).toContain('install uninstall serve');
    expect(zsh).toContain('#compdef autopg pgserve');
    expect(zsh).toContain('install:Register daemon under pm2');
  });
});

describe('pm2 registration', () => {
  test('first install spawns pm2 start with the right shape', async () => {
    const ctx = makeCtx();
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(0);
    expect(pm2Calls.length).toBe(1);
    const call = pm2Calls[0];
    expect(call.binaryPath).toBe(ctx.binaryPath);
    expect(call.cwd).toBe(getConfigDir(env));
    expect(call.port).toBe(DEFAULT_PORT);
    expect(call.dataDir).toBe(path.join(getConfigDir(env), 'data'));
  });

  test('skip pm2 when already registered (idempotent)', async () => {
    const ctx = makeCtx();
    await install(['--non-interactive'], ctx);
    expect(pm2Calls.length).toBe(1);

    // Second run: pm2GetProcess now returns the live process — no second start.
    pm2Calls = [];
    await install(['--non-interactive'], ctx);
    expect(pm2Calls.length).toBe(0);
    expect(stdout.text()).toContain('already registered');
  });

  test('returns 1 with stderr when pm2 start fails', async () => {
    const ctx = makeCtx({
      overrides: {
        pm2Start: () => ({ status: 1, stderr: 'boom' }),
      },
    });
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(1);
    expect(stderr.text()).toContain('pm2 start failed');
    expect(stderr.text()).toContain('boom');
  });

  test('warns but does not fail when pm2 is missing', async () => {
    const ctx = makeCtx({ overrides: { pm2IsAvailable: () => false } });
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(0);
    expect(stderr.text()).toContain('pm2 not found');
    expect(pm2Calls.length).toBe(0);
  });
});

describe('first-run upgrade hook', () => {
  test('runs the upgrade migrations once', async () => {
    await install(['--non-interactive'], makeCtx());
    expect(upgradeCalls.length).toBe(1);
  });

  test('non-fatal when upgrade migrations throw', async () => {
    const ctx = makeCtx({
      overrides: {
        runUpgrade: async () => { throw new Error('migration failure'); },
      },
    });
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(0);
    expect(stderr.text()).toContain('upgrade migrations skipped');
    expect(stderr.text()).toContain('migration failure');
  });

  test('non-fatal when upgrade returns non-ok', async () => {
    const ctx = makeCtx({
      overrides: {
        runUpgrade: async () => ({ ran: true, ok: false }),
      },
    });
    const code = await install(['--non-interactive'], ctx);
    expect(code).toBe(0);
    expect(stderr.text()).toContain('upgrade migrations reported a failed step');
  });
});

describe('end-to-end idempotence', () => {
  test('full re-run is a no-op success — config, link, rc, pm2 all stable', async () => {
    const ctx = makeCtx();
    expect(await install(['--non-interactive'], ctx)).toBe(0);
    const cfg1 = fs.readFileSync(getConfigPath(env), 'utf8');
    const link1 = fs.readlinkSync(path.join(getLocalBinDir(env), 'autopg'));
    const bash1 = fs.readFileSync(getRcFiles(env)[0], 'utf8');

    expect(await install(['--non-interactive'], ctx)).toBe(0);
    // updatedAt may change but binaryPath/installDir/version stay stable so
    // we only assert the load-bearing fields.
    const cfg2 = JSON.parse(fs.readFileSync(getConfigPath(env), 'utf8'));
    const cfg1Parsed = JSON.parse(cfg1);
    expect(cfg2.channel).toBe(cfg1Parsed.channel);
    expect(cfg2.port).toBe(cfg1Parsed.port);
    expect(cfg2.binaryPath).toBe(cfg1Parsed.binaryPath);
    expect(cfg2.registeredAt).toBe(cfg1Parsed.registeredAt);

    expect(fs.readlinkSync(path.join(getLocalBinDir(env), 'autopg'))).toBe(link1);
    expect(fs.readFileSync(getRcFiles(env)[0], 'utf8')).toBe(bash1);
  });
});
