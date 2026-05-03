#!/usr/bin/env node
/**
 * autopg postinstall — auto-runs `autopg upgrade` on detected upgrade.
 *
 * Behavior:
 *   - Fresh install (no ~/.autopg/data/) → exit 0 silently (no upgrade needed)
 *   - Upgrade install (data dir exists) → invoke `autopg upgrade --quiet`
 *   - Soft-fail: any error logs warning, exits 0 (never breaks `bun install`)
 *   - Skip override: AUTOPG_SKIP_POSTINSTALL=1 → exit 0 immediately
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

function main() {
  if (process.env.AUTOPG_SKIP_POSTINSTALL === '1') {
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

try {
  main();
} catch (err) {
  process.stderr.write(`[autopg-postinstall] WARNING: unexpected error: ${err.message}\n`);
}

process.exit(0);
