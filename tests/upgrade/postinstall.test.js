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

test('postinstall: dev-worktree skip emits stderr note and returns 0 (synthetic git-worktree path)', () => {
  // Build a synthetic git worktree at $tmp: <tmp>/.git is a FILE pointing at
  // `…/.git/worktrees/feature` so isDevWorktree() returns true. Symlink the
  // production postinstall.cjs into <tmp>/scripts/ so its `__dirname/..`
  // pkgRoot resolution lands inside the synthetic worktree. Spawning the
  // symlinked script exercises the full main() codepath end-to-end without
  // depending on the host CWD (CI's `actions/checkout` is at
  // /home/runner/work/pgserve/pgserve, which doesn't match the heuristic).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-e2e-'));
  try {
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: /home/x/repo/.git/worktrees/feature\n');
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.mkdirSync(path.join(tmp, 'bin'));
    fs.symlinkSync(POSTINSTALL, path.join(tmp, 'scripts', 'postinstall.cjs'));
    fs.symlinkSync(path.join(__dirname, '..', '..', 'bin', 'pgserve-wrapper.cjs'), path.join(tmp, 'bin', 'pgserve-wrapper.cjs'));

    const env = { ...process.env };
    delete env.AUTOPG_SKIP_POSTINSTALL;
    delete env.AUTOPG_CONFIG_DIR;

    const r = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'postinstall.cjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr.toString()).toContain('dev worktree detected');
    expect(r.stderr.toString()).toContain('skipping upgrade');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
