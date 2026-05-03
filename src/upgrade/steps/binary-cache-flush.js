/**
 * Step 2 — Binary cache flush.
 *
 * Verifies ~/.autopg/bin/<platform>/postgres matches PINNED_PG_VERSION.
 * If drift detected (version marker missing or mismatch), re-download via
 * the existing src/postgres.js download path.
 *
 * Idempotent: if version matches, SKIP. Extends migrateLegacyBinaryCache
 * (commit 0075c4f) with version-aware re-download.
 */

const fs = require('node:fs');
const path = require('node:path');

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

function getBinaryCacheDir() {
  const platform = `${process.platform}-${process.arch}`;
  return path.join(getAutopgRoot(), 'bin', platform);
}

function getPinnedVersion() {
  // Attempt to read from package.json's autopg.pinnedPgVersion field, fallback to env, fallback to a sane default.
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.autopg && pkg.autopg.pinnedPgVersion) return pkg.autopg.pinnedPgVersion;
  } catch { /* fall through */ }
  return process.env.AUTOPG_PINNED_PG_VERSION || '18.3';
}

function readVersionMarker(cacheDir) {
  try {
    return fs.readFileSync(path.join(cacheDir, '.version'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function plan() {
  const cacheDir = getBinaryCacheDir();
  const pinned = getPinnedVersion();
  const marker = readVersionMarker(cacheDir);
  if (!fs.existsSync(path.join(cacheDir, 'bin', 'postgres'))) {
    return `binary missing at ${cacheDir} — would trigger download for PG ${pinned}`;
  }
  if (marker !== pinned) {
    return `version drift (cached=${marker || 'unknown'}, pinned=${pinned}) — would re-download`;
  }
  return `binary present and matches pinned ${pinned}, no action needed`;
}

async function execute({ log, warn }) {
  const cacheDir = getBinaryCacheDir();
  const pinned = getPinnedVersion();
  const marker = readVersionMarker(cacheDir);
  const binaryExists = fs.existsSync(path.join(cacheDir, 'bin', 'postgres'));

  if (binaryExists && marker === pinned) {
    return { status: 'SKIP', detail: `binary OK (PG ${pinned} matches marker)` };
  }

  // Delegate to existing postgres.js downloadBinary if available; else fail-loud
  // and instruct operator. We avoid duplicating the download logic here.
  let downloadFn;
  try {
    const postgres = require('../../postgres');
    downloadFn = postgres.ensureBinary || postgres.downloadBinary || postgres.installBinary;
  } catch { /* postgres.js not loadable inline — operator path */ }

  if (!downloadFn) {
    warn(`binary needs refresh (pinned=${pinned}, cached=${marker || 'missing'}) but autopg postgres module not exposing download API`);
    warn(`operator action: rerun \`bun install -g @automagik/autopg@latest\` to repopulate binary cache`);
    return { status: 'FAIL', detail: 'binary refresh needs autopg npm reinstall' };
  }
  log(`re-downloading PG ${pinned} into ${cacheDir}`);
  await downloadFn({ version: pinned, targetDir: cacheDir });
  fs.writeFileSync(path.join(cacheDir, '.version'), pinned, { mode: 0o644 });
  return { status: 'OK', detail: `binary refreshed to PG ${pinned}` };
}

module.exports = { name: 'binary-cache-flush', plan, execute };
