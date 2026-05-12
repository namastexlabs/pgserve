/**
 * Smoke tests: postinstall hook short-circuits on fresh install + skip flag.
 * Full integration tests (synthetic 2.1.3 → 2.2.x) live in tests/integration/upgrade-*.test.js (TBD).
 */

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTINSTALL = path.join(__dirname, '..', '..', 'scripts', 'postinstall.cjs');

test('postinstall: AUTOPG_SKIP_POSTINSTALL=1 short-circuits silently', () => {
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env: { ...process.env, AUTOPG_SKIP_POSTINSTALL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout.toString()).toBe('');
});

test('postinstall: fresh install (no data dir) exits 0 silently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-test-'));
  const env = { ...process.env, AUTOPG_CONFIG_DIR: tmp };
  delete env.AUTOPG_SKIP_POSTINSTALL;
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('postinstall: isDevWorktree detects /.genie/worktrees/ paths', () => {
  // require() the script — module.exports surfaces the helpers without
  // running main() (require.main !== module guard).
  const mod = require(POSTINSTALL);
  expect(typeof mod.isDevWorktree).toBe('function');
  expect(mod.isDevWorktree('/home/foo/.genie/worktrees/pgserve/branch-x')).toBe(true);
  expect(mod.isDevWorktree('/home/foo/projects/pgserve')).toBe(false);
  expect(mod.isDevWorktree('/srv/.genie/worktrees/repo/feature')).toBe(true);
});

test('postinstall: isDevWorktree detects git worktrees via .git file with gitdir pointer', () => {
  const mod = require(POSTINSTALL);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-gitwt-'));
  try {
    // Simulate a git worktree: <root>/.git is a FILE pointing to .git/worktrees/<name>
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: /home/x/repo/.git/worktrees/feature\n');
    expect(mod.isDevWorktree(tmp)).toBe(true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('postinstall: isDevWorktree returns false for normal install paths', () => {
  const mod = require(POSTINSTALL);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-normal-'));
  try {
    // No .git file at all → not a git worktree, not under .genie/worktrees → false
    expect(mod.isDevWorktree(tmp)).toBe(false);
    // .git as a directory (regular checkout) → not a worktree
    fs.mkdirSync(path.join(tmp, '.git'));
    expect(mod.isDevWorktree(tmp)).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('postinstall: isCI honors CI=true / CI=1', () => {
  const mod = require(POSTINSTALL);
  const original = process.env.CI;
  try {
    process.env.CI = 'true'; expect(mod.isCI()).toBe(true);
    process.env.CI = '1';    expect(mod.isCI()).toBe(true);
    process.env.CI = 'false';expect(mod.isCI()).toBe(false);
    delete process.env.CI;   expect(mod.isCI()).toBe(false);
  } finally {
    if (original === undefined) delete process.env.CI;
    else process.env.CI = original;
  }
});

// main() now accepts an optional deps object so we can drive each
// branch without depending on host filesystem layout. Earlier loops
// tried (a) spawning postinstall in this worktree (broke on CI which
// isn't a worktree) and (b) symlinking the script into a synthetic
// worktree dir (broke because Node resolves symlinks before computing
// __dirname). Dependency injection avoids both classes of fragility.

test('main: emits dev-worktree skip note when isDevWorktree returns true', () => {
  let stderrContent = '';
  const stderr = { write: (s) => { stderrContent += s; } };
  const mod = require(POSTINSTALL);

  mod.main({
    env: {},
    isDevWorktree: () => true,
    pkgRoot: '/synthetic/worktrees/pgserve/branch-x',
    stderr,
  });

  expect(stderrContent).toContain('dev worktree detected');
  expect(stderrContent).toContain('skipping upgrade');
  expect(stderrContent).toContain('/synthetic/worktrees/pgserve/branch-x');
});

test('main: AUTOPG_SKIP_POSTINSTALL=1 short-circuits before isDevWorktree check', () => {
  let stderrContent = '';
  let isDevCalled = false;
  const mod = require(POSTINSTALL);

  mod.main({
    env: { AUTOPG_SKIP_POSTINSTALL: '1' },
    isDevWorktree: () => { isDevCalled = true; return true; },
    pkgRoot: '/synthetic/worktrees/pgserve/branch-x',
    stderr: { write: (s) => { stderrContent += s; } },
  });

  expect(stderrContent).toBe('');
  expect(isDevCalled).toBe(false);
});

test('main: fresh install (no data dir) exits silently when not a worktree', () => {
  let stderrContent = '';
  let spawnCalled = false;
  const mod = require(POSTINSTALL);

  mod.main({
    env: {},
    isDevWorktree: () => false,
    pkgRoot: '/normal/install',
    fs: { existsSync: () => false },              // data dir does not exist
    stderr: { write: (s) => { stderrContent += s; } },
    spawnSync: () => { spawnCalled = true; return { status: 0 }; },
    getAutopgRoot: () => '/tmp/fake-autopg-root',
  });

  expect(stderrContent).toBe('');
  expect(spawnCalled).toBe(false);
});

test('main: invokes upgrade when not worktree + data dir exists + wrapper exists + non-CI', () => {
  let stderrContent = '';
  let spawnArgs = null;
  const mod = require(POSTINSTALL);

  mod.main({
    env: {},
    isDevWorktree: () => false,
    isCI: () => false,
    pkgRoot: '/normal/install',
    fs: { existsSync: () => true },               // data dir + wrapper both exist
    stderr: { write: (s) => { stderrContent += s; } },
    spawnSync: (...args) => { spawnArgs = args; return { status: 0 }; },
    getAutopgRoot: () => '/tmp/fake-autopg-root',
  });

  // Non-CI pre-warning emitted
  expect(stderrContent).toContain('About to run');
  expect(stderrContent).toContain('AUTOPG_SKIP_POSTINSTALL=1');
  // Upgrade was invoked
  expect(spawnArgs).not.toBeNull();
  expect(spawnArgs[1]).toContain('upgrade');
  expect(spawnArgs[1]).toContain('--quiet');
});

test('main: CI=true suppresses pre-warning when invoking upgrade', () => {
  let stderrContent = '';
  const mod = require(POSTINSTALL);

  mod.main({
    env: {},
    isDevWorktree: () => false,
    isCI: () => true,
    pkgRoot: '/normal/install',
    fs: { existsSync: () => true },
    stderr: { write: (s) => { stderrContent += s; } },
    spawnSync: () => ({ status: 0 }),
    getAutopgRoot: () => '/tmp/fake-autopg-root',
  });

  expect(stderrContent).not.toContain('About to run');
});

test('upgrade orchestrator: dry-run lists 7 steps without executing', async () => {
  const { upgrade, STEPS } = await import(path.join(__dirname, '..', '..', 'src', 'upgrade', 'index.js'));
  // 7 steps after pgserve singleton (v2.4) added cosign-meta-migration.
  expect(STEPS.length).toBe(7);
  expect(STEPS.map((s) => s.name)).toContain('cosign-meta-migration');
  const r = await upgrade({ dryRun: true, quiet: true });
  expect(r.results.length).toBe(7);
  expect(r.results.every((x) => x.status === 'DRY-RUN')).toBe(true);
});
