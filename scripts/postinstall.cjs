#!/usr/bin/env node
/**
 * autopg postinstall — auto-runs `autopg upgrade` on detected upgrade.
 *
 * Behavior:
 *   - Fresh install (no ~/.autopg/data/) → exit 0 silently (no upgrade needed)
 *   - Upgrade install (data dir exists) → invoke `autopg upgrade --quiet`
 *   - Soft-fail: any error logs warning, exits 0 (never breaks `bun install`)
 *   - Skip override: AUTOPG_SKIP_POSTINSTALL=1 → exit 0 immediately
 *   - Dev-worktree auto-skip: if the package root sits inside a genie or
 *     git worktree, skip with a stderr note. Stops contributors running
 *     `bun install` in a worktree from accidentally migrating their real
 *     `~/.autopg/data` against half-built code.
 *   - Non-CI pre-warning: emit a stderr line BEFORE invoking upgrade so
 *     the operator can see what's about to happen and Ctrl+C if needed.
 *     CI runs (`CI=true`) stay quiet.
 *
 * The escape hatch for forced re-runs is `autopg upgrade` (manual).
 *
 * See: .genie/wishes/autopg-upgrade-command/WISH.md
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

function main() {
  if (process.env.AUTOPG_SKIP_POSTINSTALL === '1') {
    return;
  }
  const pkgRoot = path.resolve(__dirname, '..');
  if (isDevWorktree(pkgRoot)) {
    process.stderr.write(
      `[autopg-postinstall] dev worktree detected at ${pkgRoot} — skipping upgrade.\n` +
      '[autopg-postinstall] Set AUTOPG_SKIP_POSTINSTALL=1 to silence this notice.\n',
    );
    return;
  }
  const dataDir = path.join(getAutopgRoot(), 'data');
  if (!fs.existsSync(dataDir)) {
    // Fresh install — nothing to upgrade
    return;
  }
  // Locate own CLI entry — script is run from the package dir at install time
  const cliEntry = path.join(__dirname, '..', 'bin', 'pgserve-wrapper.cjs');
  if (!fs.existsSync(cliEntry)) {
    process.stderr.write(`[autopg-postinstall] wrapper not found at ${cliEntry}, skipping\n`);
    return;
  }
  if (!isCI()) {
    process.stderr.write(
      `[autopg-postinstall] About to run \`autopg upgrade --quiet\` against ${dataDir}.\n` +
      '[autopg-postinstall] Set AUTOPG_SKIP_POSTINSTALL=1 in the environment to skip (recommended for dev worktrees).\n',
    );
  }
  const result = spawnSync(process.execPath, [cliEntry, 'upgrade', '--quiet'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 60_000,
  });
  if (result.error) {
    process.stderr.write(`[autopg-postinstall] WARNING: upgrade invocation failed: ${result.error.message}\n`);
    process.stderr.write('[autopg-postinstall] Run `autopg upgrade` manually to retry.\n');
    return;
  }
  if (result.status !== 0) {
    process.stderr.write(`[autopg-postinstall] WARNING: \`autopg upgrade\` exited ${result.status}\n`);
    process.stderr.write('[autopg-postinstall] Run `autopg upgrade` manually to investigate.\n');
  }
}

// Test surface: postinstall.test.js exercises isDevWorktree + isCI in
// isolation (pure path + env reads, no shellouts). require() this file
// from a test to inspect the helpers without the side-effect of running
// main(); main() is only invoked when this is the entry point.
module.exports = { isDevWorktree, isCI, getAutopgRoot };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[autopg-postinstall] WARNING: unexpected error: ${err.message}\n`);
  }
  process.exit(0);
}
