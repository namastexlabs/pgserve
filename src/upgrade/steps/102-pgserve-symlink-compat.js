/**
 * Step 102 — `~/.pgserve` symlink → `~/.autopg` backward-compat shim.
 *
 * Group 3 of autopg-distribution-cutover wish. After Group 1 + 2 + the
 * existing `settings-migrate.cjs` copy already promoted the canonical
 * config dir to `~/.autopg`, this step replaces the legacy `~/.pgserve`
 * directory with a symlink so any straggling consumer code that still
 * hard-codes the old path keeps working for one milestone. A stderr
 * deprecation hint is printed once per upgrade.
 *
 * Decision branches:
 *   - `~/.pgserve` is already a symlink to `~/.autopg`            → SKIP (idempotent).
 *   - `~/.pgserve` does not exist, `~/.autopg` exists             → create symlink.
 *   - `~/.pgserve` is a directory AND `~/.autopg` does not exist  → never happens
 *     post-Group 1 (settings-migrate.cjs runs first); FAIL with a hint.
 *   - `~/.pgserve` is a directory AND `~/.autopg` exists          → leave it alone
 *     (settings-migrate.cjs already copied; operator will `rm -rf ~/.pgserve`
 *     after they're satisfied — the wish documents that flow). Print warn.
 *   - Neither exists                                              → SKIP.
 *
 * The compat window closes one milestone after this ships; the cleanup
 * step (Wave 4 Group 12) deletes both the symlink and the marker.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'pgserve-symlink-compat';

function getHome() {
  return process.env.HOME || os.homedir();
}

function getLegacyDir() {
  return path.join(getHome(), '.pgserve');
}

function getCanonicalDir() {
  return path.join(getHome(), '.autopg');
}

/**
 * Three-way classification: symlink | directory | absent.
 * `lstat` (not stat) so we don't follow the symlink we're inspecting.
 */
function classify(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw err;
  }
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'directory';
  return 'other';
}

function symlinkPointsToCanonical(linkPath, canonicalPath) {
  try {
    const target = fs.readlinkSync(linkPath);
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
    return path.resolve(resolved) === path.resolve(canonicalPath);
  } catch { return false; }
}

export async function plan() {
  const legacy = getLegacyDir();
  const canonical = getCanonicalDir();
  const legacyKind = classify(legacy);
  const canonicalKind = classify(canonical);

  if (legacyKind === 'symlink' && symlinkPointsToCanonical(legacy, canonical)) {
    return `${legacy} symlink already → ${canonical}, no action`;
  }
  if (legacyKind === 'absent' && canonicalKind === 'directory') {
    return `would symlink ${legacy} → ${canonical}`;
  }
  if (legacyKind === 'directory' && canonicalKind === 'directory') {
    return `${legacy} is still a real directory (post-migration leftover); will leave it and warn`;
  }
  if (legacyKind === 'directory' && canonicalKind === 'absent') {
    return `${canonical} missing but ${legacy} exists — would FAIL (settings-migrate.cjs should run first)`;
  }
  if (legacyKind === 'absent' && canonicalKind === 'absent') {
    return 'neither legacy nor canonical config dir present (fresh untouched host) — no action';
  }
  if (legacyKind === 'symlink' && !symlinkPointsToCanonical(legacy, canonical)) {
    return `${legacy} is a symlink to an unexpected target — would warn and leave alone`;
  }
  return `unexpected layout (legacy=${legacyKind}, canonical=${canonicalKind}) — no action`;
}

export async function execute({ warn }) {
  const legacy = getLegacyDir();
  const canonical = getCanonicalDir();
  const legacyKind = classify(legacy);
  const canonicalKind = classify(canonical);

  if (legacyKind === 'symlink' && symlinkPointsToCanonical(legacy, canonical)) {
    return { status: 'SKIP', detail: `${legacy} → ${canonical} (already linked)` };
  }

  if (legacyKind === 'directory' && canonicalKind === 'absent') {
    return { status: 'FAIL', detail: `${canonical} missing; expected settings-migrate.cjs to populate first` };
  }

  if (legacyKind === 'directory' && canonicalKind === 'directory') {
    process.stderr.write(
      `[pgserve-symlink-compat] DEPRECATION: ${legacy} still exists as a directory ` +
      `alongside ${canonical}. settings-migrate.cjs preserves it for rollback; ` +
      `delete it once you're satisfied autopg works:\n    rm -rf ${legacy}\n`,
    );
    return { status: 'SKIP', detail: `${legacy} kept as directory for rollback safety` };
  }

  if (legacyKind === 'absent' && canonicalKind === 'directory') {
    fs.symlinkSync(canonical, legacy);
    process.stderr.write(
      `[pgserve-symlink-compat] DEPRECATION: ~/.pgserve is now a symlink to ~/.autopg ` +
      `for one-milestone backward-compat. Consumers should switch to ~/.autopg ` +
      `(or AUTOPG_CONFIG_DIR) before the next release.\n`,
    );
    return { status: 'OK', detail: `created symlink ${legacy} → ${canonical}` };
  }

  if (legacyKind === 'symlink' && !symlinkPointsToCanonical(legacy, canonical)) {
    warn(`[pgserve-symlink-compat] ${legacy} is a symlink to an unexpected target — leaving in place`);
    return { status: 'SKIP', detail: 'unexpected pre-existing symlink — left alone' };
  }

  if (legacyKind === 'absent' && canonicalKind === 'absent') {
    return { status: 'SKIP', detail: 'no config dirs to link (fresh host)' };
  }

  return { status: 'SKIP', detail: `unexpected layout (legacy=${legacyKind}, canonical=${canonicalKind})` };
}
