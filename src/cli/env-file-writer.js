/**
 * Atomic env-file writer for `~/.autopg/<app>.env` (Group 5,
 * autopg-distribution-cutover wish).
 *
 * Contract (from wish §Group 5 deliverable 5):
 *   - mode 0o600 on the resulting file
 *   - parent dir created with mode 0o700 if missing
 *   - atomic-rename pattern: write tmp → fsync → rename → fsync(parent)
 *   - concurrent reader never sees a half-written file (the rename is the
 *     visible-state flip; the partial tmp file is invisible until renamed)
 *
 * Used by `autopg create-app` and `autopg rotate` to emit the per-app
 * env file containing `DATABASE_URL=postgres://<role>:<password>@…/<db>`.
 *
 * The writer is intentionally single-purpose — no key/value abstraction.
 * Callers shape the body once (URL-encode password, escape any newlines).
 */

import fs from 'fs';
import path from 'path';

/**
 * Atomically write `content` to `targetPath` with mode 0o600.
 *
 * @param {string} targetPath - absolute path to the env file
 * @param {string} content - body, MUST end with newline if you want a clean POSIX file
 * @returns {{path: string, bytes: number}}
 */
export function writeEnvFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten parent dir perms regardless — first-run could have created
  // ~/.autopg with broader perms via a different code path (e.g. an
  // older pgserve that ran with umask 022).
  try { fs.chmodSync(dir, 0o700); } catch { /* swallow — best effort */ }

  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* swallow */ }
    }
  }
  // Belt-and-suspenders: enforce 0600 in case umask widened it before fsync.
  try { fs.chmodSync(tmp, 0o600); } catch { /* swallow */ }

  fs.renameSync(tmp, targetPath);
  // Final perm clamp on the renamed inode — same belt-and-suspenders shape
  // admin-bootstrap.js uses for the same reason (Sentinel B1: never trust
  // umask defaults for credential files).
  try { fs.chmodSync(targetPath, 0o600); } catch { /* swallow */ }

  // fsync(parent dir) so the rename itself is durable across crashes.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Some filesystems (e.g. tmpfs) don't support directory fsync — that's
    // OK; the rename + file fsync is enough for our durability bar.
  }

  return { path: targetPath, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Build the canonical env-file body for a per-app credential.
 *
 * Shape: `DATABASE_URL=…\n` (single line, single value). Future fields go
 * below — keep DATABASE_URL on line 1 so a `head -1 | cut` extraction works
 * even before consumers learn about the file shape.
 *
 * @param {object} args
 * @param {string} args.role
 * @param {string} args.password
 * @param {string} args.database
 * @param {string} [args.host='127.0.0.1']
 * @param {number} [args.port=8432]
 * @returns {string}
 */
export function renderEnvFileBody({
  role,
  password,
  database,
  host = '127.0.0.1',
  port = 8432,
}) {
  if (!role || !password || !database) {
    throw new Error('renderEnvFileBody: role, password, and database are required');
  }
  const encodedRole = encodeURIComponent(role);
  const encodedPassword = encodeURIComponent(password);
  const url = `postgres://${encodedRole}:${encodedPassword}@${host}:${port}/${database}`;
  return `DATABASE_URL=${url}\n`;
}

/**
 * Resolve the env-file path for an app slug.
 *
 * @param {string} app
 * @param {string} configDir
 * @returns {string}
 */
export function envFilePathFor(app, configDir) {
  return path.join(configDir, `${app}.env`);
}
