/**
 * `~/.autopg/admin.json` reader, atomic writer, and supervisor-assertion.
 *
 * Cohort-shared module — co-owned with `canonical-pgserve-pm2-supervision`
 * Group 1. Schema for the supervisor record:
 *
 *     {
 *       supervisor: "pm2" | "systemd-user" | "launchd" | "external",
 *       socketDir:  "<absolute path>",
 *       port:       <integer>,
 *       installedAt: "<ISO 8601 timestamp>"
 *     }
 *
 * The file is shared with the Basic-Auth scrypt password record used by the
 * autopg console UI (`scheme`/`salt`/`hash`/...). This module merges with
 * any pre-existing fields it does not own — `writeAdminJson` is additive,
 * never destructive — so both tenants coexist on the same file.
 *
 * Hard contract — refuses to downgrade supervision authority:
 *   - If the existing file records `systemd-user` or `launchd`, refuses to
 *     write `pm2` or `external`. Operators must `autopg service uninstall`
 *     first to migrate Tier B → Tier A.
 *   - `assertSupervisor(expected)` throws when the actual supervisor differs
 *     so callers fail fast with a structured remediation hint.
 *
 * Atomic semantics: write to `<file>.tmp.<pid>`, fsync, then
 * `fs.renameSync` to the target. mode 0600 enforced via `fs.chmodSync`
 * after write.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const ADMIN_FILE_NAME = 'admin.json';
export const ADMIN_FILE_MODE = 0o600;

export const SUPERVISOR_VALUES = Object.freeze([
  'pm2',
  'systemd-user',
  'launchd',
  'external',
]);

/** Supervisors that own the postmaster lifecycle via an OS service unit. */
const TIER_B_SUPERVISORS = new Set(['systemd-user', 'launchd']);

/**
 * Resolve the autopg config directory.
 *
 * Honors `AUTOPG_CONFIG_DIR` (current var) first, then `PGSERVE_CONFIG_DIR`
 * (legacy soft-rename), then `$HOME/.autopg`. Mirrors the precedence in
 * `src/cli-install.cjs` and `src/settings-loader.cjs`.
 */
export function getDefaultConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR
    || process.env.PGSERVE_CONFIG_DIR
    || path.join(os.homedir(), '.autopg')
  );
}

export function getAdminFilePath(configDir = getDefaultConfigDir()) {
  return path.join(configDir, ADMIN_FILE_NAME);
}

function ensureConfigDir(configDir) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read the admin.json record. Returns the parsed object on success, `null`
 * when the file is missing or unreadable. Never throws — callers treat
 * "missing" and "broken" identically.
 */
export function readAdminJson({ configDir = getDefaultConfigDir() } = {}) {
  const file = getAdminFilePath(configDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateSupervisorRecord(record) {
  if (!isPlainObject(record)) {
    throw new TypeError('admin-json: record must be an object');
  }
  if (!SUPERVISOR_VALUES.includes(record.supervisor)) {
    throw new TypeError(
      `admin-json: invalid supervisor "${record.supervisor}". `
      + `Expected one of: ${SUPERVISOR_VALUES.join(', ')}`,
    );
  }
  if (typeof record.socketDir !== 'string' || record.socketDir.length === 0) {
    throw new TypeError('admin-json: socketDir must be a non-empty string');
  }
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    throw new TypeError(`admin-json: port must be an integer in [1, 65535]; got ${record.port}`);
  }
  if (typeof record.installedAt !== 'string' || record.installedAt.length === 0) {
    throw new TypeError('admin-json: installedAt must be a non-empty ISO 8601 string');
  }
}

/**
 * Atomic merge-write of the supervisor record.
 *
 * Reads any existing admin.json, layers the supplied supervisor fields on
 * top (preserving unrelated fields like the scrypt Basic-Auth scheme), and
 * writes the result via tmp+rename with mode 0600.
 *
 * Refuses with a structured error when the existing record names a Tier B
 * supervisor (`systemd-user` / `launchd`) and the incoming record would
 * downgrade authority. Use `autopg service uninstall` to migrate Tier B →
 * Tier A explicitly.
 */
export function writeAdminJson(record, { configDir = getDefaultConfigDir() } = {}) {
  validateSupervisorRecord(record);

  ensureConfigDir(configDir);
  const file = getAdminFilePath(configDir);
  const existing = readAdminJson({ configDir }) ?? {};

  if (
    TIER_B_SUPERVISORS.has(existing.supervisor)
    && existing.supervisor !== record.supervisor
  ) {
    const err = new Error(
      `pgserve: refusing to overwrite admin.json — existing supervisor is `
      + `"${existing.supervisor}" (Tier B); cannot register "${record.supervisor}". `
      + `Run \`autopg service uninstall\` first to migrate to Tier A.`,
    );
    err.code = 'EADMINSUPERVISORLOCK';
    err.existingSupervisor = existing.supervisor;
    err.requestedSupervisor = record.supervisor;
    throw err;
  }

  const merged = {
    ...existing,
    supervisor: record.supervisor,
    socketDir: record.socketDir,
    port: record.port,
    installedAt: record.installedAt,
  };

  const tmp = `${file}.tmp.${process.pid}`;
  const json = `${JSON.stringify(merged, null, 2)}\n`;
  fs.writeFileSync(tmp, json, { mode: ADMIN_FILE_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, ADMIN_FILE_MODE);

  return merged;
}

/**
 * Throw when the on-disk supervisor differs from `expected`. Returns the
 * record on match. Used by callers that must refuse to operate when the
 * host has already been claimed by a different supervisor — e.g.
 * `pgserve install` (Tier A) refusing to run on a Tier B host.
 *
 * Missing file is NOT an error here — there's nothing to assert against.
 * The caller should treat "no record" as "free to install".
 */
export function assertSupervisor(expected, { configDir = getDefaultConfigDir() } = {}) {
  if (!SUPERVISOR_VALUES.includes(expected)) {
    throw new TypeError(
      `admin-json: invalid expected supervisor "${expected}". `
      + `Expected one of: ${SUPERVISOR_VALUES.join(', ')}`,
    );
  }
  const existing = readAdminJson({ configDir });
  if (!existing || !existing.supervisor) return null;
  if (existing.supervisor !== expected) {
    const err = new Error(
      `pgserve: admin.json supervisor mismatch — expected "${expected}", `
      + `found "${existing.supervisor}". `
      + `${TIER_B_SUPERVISORS.has(existing.supervisor)
          ? 'Run `autopg service uninstall` to migrate to Tier A.'
          : 'Run `pgserve uninstall` to clear the existing record.'}`,
    );
    err.code = 'EADMINSUPERVISORMISMATCH';
    err.expected = expected;
    err.actual = existing.supervisor;
    throw err;
  }
  return existing;
}
