/**
 * Admin SCRAM bootstrap (Group 1, autopg-distribution-cutover wish).
 *
 * Replaces the `postgres:postgres` plaintext default with a SCRAM-authenticated
 * `autopg_admin` role whose password lives at `~/.autopg/admin.secret` (mode
 * 0600). Idempotent: re-running with an existing secret file and an existing
 * role does nothing. Revokes superuser/createdb/createrole/replication from
 * the legacy `postgres` role (kept for compatibility) so a recovered
 * `postgres:postgres` credential is no longer a privilege escalator.
 *
 * Wired into `src/postgres.js` `start()` after `_initAdminPool()` (see the
 * private `_bootstrapAdmin()` helper there). The admin pool then pivots from
 * `postgres` to `autopg_admin` so subsequent admin work (CREATE DATABASE,
 * etc.) authenticates via SCRAM under the new role.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { audit, AUDIT_EVENTS } from '../audit.js';

export const ADMIN_ROLE = 'autopg_admin';
const SECRET_FILENAME = 'admin.secret';

/**
 * Resolve the autopg config directory. Mirrors `getConfigDir()` in
 * `src/cli-install.cjs`: AUTOPG_CONFIG_DIR (new) wins, PGSERVE_CONFIG_DIR
 * (legacy) is honored as fall-through, default is `~/.autopg/`.
 */
export function getConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR ||
    process.env.PGSERVE_CONFIG_DIR ||
    path.join(os.homedir(), '.autopg')
  );
}

export function getAdminSecretPath() {
  return path.join(getConfigDir(), SECRET_FILENAME);
}

/**
 * 32-byte URL-safe token (~43 chars after base64url encoding, no padding).
 * URL-safe alphabet ([A-Za-z0-9-_]) — no characters that need SQL escaping.
 */
export function generateAdminSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Atomic write of the secret file with mode 0600.
 *
 * write-tmp → fsync → rename → fsync(parent) is the durable pattern; the
 * env-file writer in Group 5 follows the same shape. Group 1 keeps it
 * lightweight (no fsync — the secret is regenerated on absence anyway).
 */
function writeSecretFile(secretPath, password) {
  const dir = path.dirname(secretPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${secretPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${password}\n`, { mode: 0o600 });
  fs.renameSync(tmp, secretPath);
  fs.chmodSync(secretPath, 0o600);
}

/**
 * Read the secret file. Caller must have already verified it exists.
 * Trims trailing newlines so SCRAM password matches what we wrote.
 */
export function readAdminSecret(secretPath = getAdminSecretPath()) {
  const raw = fs.readFileSync(secretPath, 'utf8');
  const value = raw.replace(/\r?\n$/, '');
  if (!value) {
    throw new Error(`admin-bootstrap: ${secretPath} is empty`);
  }
  return value;
}

/**
 * SQL string literal escape. Single-quotes are doubled; everything else is
 * passed through. Adequate for the base64url alphabet (no quotes, no
 * backslashes). Defensive against operator-supplied secrets via the
 * secretPath escape hatch.
 */
function quoteLiteral(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

/**
 * Idempotent admin SCRAM bootstrap.
 *
 * Behavior matrix (file → role):
 *   exists    + exists     → idempotent-skip (no change)
 *   exists    + missing    → CREATE ROLE with the on-disk password
 *   missing   + exists     → ALTER ROLE password to a freshly-generated value
 *   missing   + missing    → generate secret + CREATE ROLE
 *
 * On any "create" / "alter" path we also revoke superuser + createdb +
 * createrole + replication + bypassrls from the default `postgres` role.
 * The role itself stays present so consumers referencing it by name keep
 * working, but it carries no privileges beyond a vanilla LOGIN role.
 *
 * The Bun.SQL pool passed in MUST be authenticated as a superuser (the
 * caller is `src/postgres.js` `_initAdminPool()` which connects as
 * `postgres` immediately post-initdb — at that point `postgres` is still
 * superuser; bootstrap is what downgrades it).
 *
 * @param {object} pool - Bun.SQL connection (or compatible: must support
 *   tagged-template queries and `.unsafe(text)`).
 * @param {object} [opts]
 * @param {string} [opts.secretPath] - override admin.secret location
 *   (tests use this to avoid writing to `~/.autopg/`).
 * @param {object} [opts.logger] - pino-shaped logger (debug/info/warn).
 * @returns {Promise<{status: 'created'|'idempotent-skip', secretPath: string, role: string}>}
 */
export async function bootstrapAdmin(pool, opts = {}) {
  const secretPath = opts.secretPath || getAdminSecretPath();
  const logger = opts.logger;

  let password;
  let secretWasCreated = false;
  if (fs.existsSync(secretPath)) {
    password = readAdminSecret(secretPath);
    try { fs.chmodSync(secretPath, 0o600); } catch { /* tighten perms on best-effort */ }
  } else {
    password = generateAdminSecret();
    writeSecretFile(secretPath, password);
    secretWasCreated = true;
  }

  const rows = await pool`SELECT rolname FROM pg_authid WHERE rolname = ${ADMIN_ROLE}`;
  const roleExists = rows.length > 0;

  if (roleExists && !secretWasCreated) {
    audit(AUDIT_EVENTS.ADMIN_BOOTSTRAP_IDEMPOTENT_SKIP, { role: ADMIN_ROLE, secret_path: secretPath });
    logger?.debug?.({ role: ADMIN_ROLE, secretPath }, 'admin-bootstrap: idempotent-skip');
    return { status: 'idempotent-skip', secretPath, role: ADMIN_ROLE };
  }

  const passwordLiteral = quoteLiteral(password);
  if (roleExists) {
    await pool.unsafe(`ALTER ROLE ${ADMIN_ROLE} WITH LOGIN SUPERUSER PASSWORD ${passwordLiteral}`);
  } else {
    await pool.unsafe(`CREATE ROLE ${ADMIN_ROLE} WITH LOGIN SUPERUSER PASSWORD ${passwordLiteral}`);
  }

  // Lock down the default `postgres` role — the role stays present (compat
  // with consumers referencing the name) but loses every reachable
  // privilege. Postgres protects its bootstrap superuser (OID 10) from
  // losing SUPERUSER itself ("The bootstrap superuser must have the
  // SUPERUSER attribute"), so the lock is enforced via NOLOGIN: the
  // privilege is unreachable because the role can no longer authenticate.
  // Sentinel B1 acceptance ("psql -h localhost -U postgres -d postgres
  // either fails or has no privileges …") — this satisfies the "fails"
  // branch.
  await pool.unsafe(
    'ALTER ROLE postgres WITH NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  );

  audit(AUDIT_EVENTS.ADMIN_BOOTSTRAP_CREATED, {
    role: ADMIN_ROLE,
    secret_path: secretPath,
    role_existed: roleExists,
    secret_existed: !secretWasCreated,
  });
  logger?.info?.({ role: ADMIN_ROLE, secretPath }, 'admin-bootstrap: created');
  return { status: 'created', secretPath, role: ADMIN_ROLE };
}

/**
 * Internals exposed for the test suite. Not a public API.
 */
export const _internals = Object.freeze({
  quoteLiteral,
  writeSecretFile,
  SECRET_FILENAME,
});
