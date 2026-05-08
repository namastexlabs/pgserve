/**
 * Structured audit emitter for privilege-changing operations.
 *
 * Group 6 of autopg-distribution-cutover. This is the v1 audit surface
 * consumed by Group 5's `create-app` / `list` / `revoke` / `rotate` and the
 * LOCK 1 manifest verifier. Distinct from the legacy `src/audit.js` event
 * stream (DB lifecycle, connection routing): that stream is `event`-keyed
 * and writes to `~/.autopg/audit.log`; this stream is `op`-keyed and writes
 * to `~/.autopg/logs/audit.log` with `schemaVersion: 1`.
 *
 * Records are JSON Lines. Every emit produces exactly one line. The shape
 * is fixed at v1 to give the redaction lint a stable target — adding a new
 * field is a `schemaVersion: 2` migration, not an in-place addition.
 *
 * Threat model the redaction lint guards:
 *   - The audit log will leak. Plan for it.
 *   - Therefore: no field name may be a secret category, and no value may
 *     be sourced from `process.env.*PASSWORD*` (or matching token/secret
 *     patterns). The lint enforces this at every call site.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const AUDIT_SCHEMA_VERSION = 1;

export const AUDIT_OPS = Object.freeze({
  CREATE_APP: 'create-app',
  REVOKE: 'revoke',
  ROTATE: 'rotate',
  MANIFEST_VERIFY: 'manifest-verify',
  MANIFEST_VERIFY_BYPASS: 'manifest-verify-bypass',
  ADOPT_EXISTING_DB: 'adopt-existing-db',
});

const VALID_OPS = new Set(Object.values(AUDIT_OPS));

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function getConfigDir() {
  return (
    process.env.AUTOPG_CONFIG_DIR ||
    process.env.PGSERVE_CONFIG_DIR ||
    path.join(os.homedir(), '.autopg')
  );
}

function defaultLogPath() {
  return path.join(getConfigDir(), 'logs', 'audit.log');
}

let LOG_PATH = defaultLogPath();

/**
 * Override the audit log path. Tests use this to redirect into a scratch
 * dir; the daemon may use it if `AUTOPG_CONFIG_DIR` is set after import.
 *
 * Pass no argument to reset to the default (re-resolves env vars).
 *
 * @param {{logFile?: string}} [cfg]
 */
export function configureAuditEmit(cfg = {}) {
  if (cfg.logFile) {
    LOG_PATH = cfg.logFile;
    return;
  }
  LOG_PATH = defaultLogPath();
}

export function getAuditLogPath() {
  return LOG_PATH;
}

/**
 * Emit a single audit record.
 *
 * Required: `op`, `actor`. Optional: `app`, `role`, `manifestSha256`,
 * `sigVerified`, `incidentId`. Unknown fields are passed through verbatim
 * so call sites stay flexible — but the redaction lint validates that the
 * payload never contains secret-shaped names or env-sourced secret values.
 *
 * Record shape on disk (JSON Lines):
 *   {"schemaVersion":1,"ts":"<iso>","op":"create-app",...}
 *
 * Returns the written record (mostly for tests; production callers ignore).
 *
 * @param {object} record
 * @param {string} record.op - one of AUDIT_OPS
 * @param {string} [record.actor] - OS user or admin role performing the op
 * @param {string} [record.app] - target app name
 * @param {string} [record.role] - target postgres role
 * @param {string} [record.manifestSha256] - hex sha256 of the verified manifest
 * @param {boolean} [record.sigVerified] - whether the manifest sig verified
 * @param {string} [record.incidentId] - present only when bypass was used
 * @returns {object}
 */
export function auditEmit(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('auditEmit: record must be an object');
  }
  if (typeof record.op !== 'string' || !VALID_OPS.has(record.op)) {
    throw new Error(
      `auditEmit: unknown op "${record.op}". Allowed: ${[...VALID_OPS].join(', ')}`
    );
  }

  const out = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    ...record,
  };

  writeJsonLine(out, LOG_PATH);
  return out;
}

function writeJsonLine(record, logFile) {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  const fd = fs.openSync(logFile, 'a', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(logFile, FILE_MODE);
  } catch { /* best-effort tighten */ }
}

