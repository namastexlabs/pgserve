/**
 * Step 2 — Binary cache flush against PINNED_PG_VERSION.
 * Re-downloads if version marker missing or mismatch. Idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'binary-cache-flush';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

function getBinaryCacheDir() {
  return path.join(getAutopgRoot(), 'bin', `${process.platform}-${process.arch}`);
}

function getPinnedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    if (pkg.autopg && pkg.autopg.pinnedPgVersion) return pkg.autopg.pinnedPgVersion;
  } catch { /* fall through */ }
  return process.env.AUTOPG_PINNED_PG_VERSION || '18.3';
}

function readVersionMarker(cacheDir) {
  try { return fs.readFileSync(path.join(cacheDir, '.version'), 'utf8').trim(); } catch { return null; }
}

export async function plan() {
  const cacheDir = getBinaryCacheDir();
  const pinned = getPinnedVersion();
  const marker = readVersionMarker(cacheDir);
  if (!fs.existsSync(path.join(cacheDir, 'bin', 'postgres'))) {
    return `binary missing at ${cacheDir} — would trigger download for PG ${pinned}`;
  }
  if (marker !== pinned) return `version drift (cached=${marker || 'unknown'}, pinned=${pinned}) — would re-download`;
  return `binary present and matches pinned ${pinned}, no action needed`;
}

export async function execute({ log, warn }) {
  const cacheDir = getBinaryCacheDir();
  const pinned = getPinnedVersion();
  const marker = readVersionMarker(cacheDir);
  const binaryExists = fs.existsSync(path.join(cacheDir, 'bin', 'postgres'));

  if (binaryExists && marker === pinned) return { status: 'SKIP', detail: `binary OK (PG ${pinned})` };

  let downloadFn;
  try {
    const postgres = await import('../../postgres.js');
    downloadFn = postgres.ensureBinary || postgres.downloadBinary || postgres.installBinary;
  } catch { /* postgres module not loadable here */ }

  if (!downloadFn) {
    warn(`binary needs refresh (pinned=${pinned}, cached=${marker || 'missing'}) but autopg postgres module not exposing download API`);
    warn(`operator action: rerun \`bun install -g @automagik/autopg@latest\``);
    return { status: 'FAIL', detail: 'binary refresh needs autopg npm reinstall' };
  }
  log(`re-downloading PG ${pinned} into ${cacheDir}`);
  await downloadFn({ version: pinned, targetDir: cacheDir });
  fs.writeFileSync(path.join(cacheDir, '.version'), pinned, { mode: 0o644 });
  return { status: 'OK', detail: `binary refreshed to PG ${pinned}` };
}
