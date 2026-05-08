/**
 * Canonical pgserve socket-dir resolver.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 1.
 *
 * Postgres backend listens on a Unix socket inside this directory plus TCP
 * 5432. The directory is also where `pgserve` records its `.s.PGSQL.<port>`
 * socket file so off-the-shelf libpq clients connecting via
 * `psql -h <socketDir>` (no `-p`) succeed against the systemd / freedesktop
 * convention path. CI runners and minimal containers without
 * `$XDG_RUNTIME_DIR` get `/tmp/pgserve` as the documented fallback.
 */

import fs from 'fs';
import path from 'path';

export const SOCKET_DIR_NAME = 'pgserve';
export const SOCKET_DIR_MODE = 0o700;

/**
 * Resolve the canonical socket directory.
 *
 * Preferred: `$XDG_RUNTIME_DIR/pgserve` (systemd / freedesktop convention).
 * Fallback: `/tmp/pgserve` (CI runners and minimal containers without XDG).
 *
 * Pure function — does not touch the filesystem. Use `ensureSocketDir()`
 * to create the directory with the correct permissions.
 */
export function resolveSocketDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : '/tmp';
  return path.join(base, SOCKET_DIR_NAME);
}

/**
 * Ensure the socket directory exists with mode 0700 and is writable.
 *
 * Returns the resolved path. Throws if the directory exists but is not a
 * directory, or if creation fails for any reason other than EEXIST.
 *
 * The mode is enforced via fs.chmodSync after creation — `mkdirSync(mode)`
 * is honored only when the directory does not already exist.
 */
export function ensureSocketDir(dir = resolveSocketDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: SOCKET_DIR_MODE });
  fs.chmodSync(dir, SOCKET_DIR_MODE);

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(
      `pgserve: socket dir path exists but is not a directory: ${dir}`,
    );
  }

  // Validate writability by touching a sentinel file. Avoids surfacing the
  // real-world failure ("postgres can't bind socket") at the postmaster
  // boot step where the diagnostic is much harder to trace.
  const probe = path.join(dir, `.writable-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(
      `pgserve: socket dir not writable (${dir}): ${err.message}`,
    );
  }

  return dir;
}
