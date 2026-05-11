#!/usr/bin/env node
/**
 * pgserve postinstall — auto-runs `pgserve update` on detected in-place update.
 *
 * v3.0.0 verb rename: this hook used to invoke `autopg upgrade`. The verb is
 * now `pgserve update` (clean cutover; no alias). The hook still ships in the
 * npm tarball for any straggling `npm install pgserve` operators on v2.6.x;
 * the canonical install path going forward is `curl … install.sh | bash`
 * (see autopg-distribution-cutover-finalize G1 + Felipe directive 2026-05-10).
 *
 * Behavior:
 *   - Fresh install (no ~/.autopg/data/) → exit 0 silently (no update needed)
 *   - Update install (data dir exists) → invoke `pgserve update --quiet`
 *   - Soft-fail: any error logs warning, exits 0 (never breaks `bun install`)
 *   - Skip override: AUTOPG_SKIP_POSTINSTALL=1 → exit 0 immediately
 *   - Dev-worktree auto-skip: if the package root sits inside a genie or
 *     git worktree, skip with a stderr note. Stops contributors running
 *     `bun install` in a worktree from accidentally migrating their real
 *     `~/.autopg/data` against half-built code.
 *   - Non-CI pre-warning: emit a stderr line BEFORE invoking update so
 *     the operator can see what's about to happen and Ctrl+C if needed.
 *     CI runs (`CI=true`) stay quiet.
 *
 * The escape hatch for forced re-runs is `pgserve update` (manual).
 *
 * See: .genie/wishes/autopg-upgrade-command/WISH.md (original wish, verb
 *      renamed in v3.0.0 cutover).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

/**
 * Return true if the package root sits inside a development worktree.
 *
 * Two markers:
 *   1. Genie convention: path contains `/.genie/worktrees/`
 *   2. Git worktree:    `<pkgRoot>/.git` is a FILE (not a dir) whose
 *      `gitdir:` pointer references another `.git/worktrees/...`
 *
 * Either marker is enough; both have high precision for "this is a
 * dev checkout, not a real consumer install".
 */
function isDevWorktree(pkgRoot) {
  const sep = path.sep;
  if (pkgRoot.includes(`${sep}.genie${sep}worktrees${sep}`)) return true;
  try {
    const gitMarker = path.join(pkgRoot, '.git');
    const stat = fs.statSync(gitMarker);
    if (stat.isFile()) {
      const content = fs.readFileSync(gitMarker, 'utf8');
      if (content.includes(`${sep}.git${sep}worktrees${sep}`)) return true;
    }
  } catch {
    // No .git, unreadable, or path resolution error — not a worktree
  }
  return false;
}

function isCI() {
  const v = process.env.CI;
  return v === 'true' || v === '1';
}

/**
 * Decision-and-side-effect entry. Accepts an optional `deps` object so
 * tests can drive each branch (worktree-skip, fresh-install, CI-quiet,
 * update-invoke, soft-fail-on-error) without depending on the host
 * environment. Production callers invoke `main()` with no args; the
 * defaults reproduce the original behavior verbatim.
 *
 * Why dependency injection: a previous spawn-and-grep test attempted
 * to verify the worktree-skip stderr by symlinking the script into a
 * synthetic worktree dir. Node's symlink resolution defeated that —
 * `__dirname` inside the script points at the real-on-disk source, not
 * the symlink target — so `isDevWorktree(pkgRoot)` saw the real pkgRoot
 * and the stderr note never fired. Injecting `pkgRoot` + the heuristic
 * function decouples behavior from filesystem layout for tests.
 */
function main(deps = {}) {
  const env = deps.env ?? process.env;
  const pkgRoot = deps.pkgRoot ?? path.resolve(__dirname, '..');
  const isDevWorktreeFn = deps.isDevWorktree ?? isDevWorktree;
  const isCIFn = deps.isCI ?? isCI;
  const getAutopgRootFn = deps.getAutopgRoot
    ?? (() => env.AUTOPG_CONFIG_DIR || env.PGSERVE_CONFIG_DIR || `${env.HOME}/.autopg`);
  const fsApi = deps.fs ?? fs;
  const stderr = deps.stderr ?? process.stderr;
  const spawnSyncFn = deps.spawnSync ?? spawnSync;

  if (env.AUTOPG_SKIP_POSTINSTALL === '1') {
    return;
  }
  if (isDevWorktreeFn(pkgRoot)) {
    stderr.write(
      `[pgserve-postinstall] dev worktree detected at ${pkgRoot} — skipping update.\n` +
      '[pgserve-postinstall] Set AUTOPG_SKIP_POSTINSTALL=1 to silence this notice.\n',
    );
    return;
  }
  const dataDir = path.join(getAutopgRootFn(), 'data');
  if (!fsApi.existsSync(dataDir)) {
    // Fresh install — nothing to update
    return;
  }
  // Locate own CLI entry — script is run from the package dir at install time
  const cliEntry = path.join(pkgRoot, 'bin', 'autopg-wrapper.cjs');
  if (!fsApi.existsSync(cliEntry)) {
    stderr.write(`[pgserve-postinstall] wrapper not found at ${cliEntry}, skipping\n`);
    return;
  }
  if (!isCIFn()) {
    stderr.write(
      `[pgserve-postinstall] About to run \`pgserve update --quiet\` against ${dataDir}.\n` +
      '[pgserve-postinstall] Set AUTOPG_SKIP_POSTINSTALL=1 in the environment to skip (recommended for dev worktrees).\n',
    );
  }
  const result = spawnSyncFn(process.execPath, [cliEntry, 'update', '--quiet'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 60_000,
  });
  if (result.error) {
    stderr.write(`[pgserve-postinstall] WARNING: update invocation failed: ${result.error.message}\n`);
    stderr.write('[pgserve-postinstall] Run `pgserve update` manually to retry.\n');
    return;
  }
  if (result.status !== 0) {
    stderr.write(`[pgserve-postinstall] WARNING: \`pgserve update\` exited ${result.status}\n`);
    stderr.write('[pgserve-postinstall] Run `pgserve update` manually to investigate.\n');
  }
}

// Test surface: postinstall.test.js exercises isDevWorktree + isCI in
// isolation (pure path + env reads, no shellouts). require() this file
// from a test to inspect the helpers without the side-effect of running
// main(); main() is only invoked when this is the entry point.
module.exports = { isDevWorktree, isCI, getAutopgRoot, main };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[autopg-postinstall] WARNING: unexpected error: ${err.message}\n`);
  }
  process.exit(0);
}
