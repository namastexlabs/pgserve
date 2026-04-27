/**
 * pgserve audit log — JSONL writer with in-process rotation + syslog tier.
 *
 * Tier 1 (default): `~/.pgserve/audit.log`, rotated 50 MB × 5 files.
 * Tier 2 (opt-in):  local syslog via `logger -t pgserve-audit`, one spawn per event.
 * Tier 3 (HTTP webhook): deferred to v2.1.
 *
 * Configuration source-of-truth is the active package.json's
 * `pgserve.audit.target` field; the daemon (Group 3) resolves it per peer
 * and threads the value through `audit(event, fields, { target })`.
 *
 * The seven event names defined for v2.0 (one row per audit() call):
 *   db_created
 *   db_reaped_ttl
 *   db_reaped_liveness
 *   db_persist_honored
 *   connection_routed
 *   connection_denied_fingerprint_mismatch
 *   enforcement_kill_switch_used
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

export const AUDIT_EVENTS = Object.freeze({
  DB_CREATED: 'db_created',
  DB_REAPED_TTL: 'db_reaped_ttl',
  DB_REAPED_LIVENESS: 'db_reaped_liveness',
  DB_PERSIST_HONORED: 'db_persist_honored',
  CONNECTION_ROUTED: 'connection_routed',
  CONNECTION_DENIED_FINGERPRINT_MISMATCH: 'connection_denied_fingerprint_mismatch',
  ENFORCEMENT_KILL_SWITCH_USED: 'enforcement_kill_switch_used',
});

const VALID_EVENTS = new Set(Object.values(AUDIT_EVENTS));

const ROTATE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB
const ROTATE_KEEP = 5;

let DEFAULT_LOG_DIR = path.join(os.homedir(), '.pgserve');
let DEFAULT_LOG_PATH = path.join(DEFAULT_LOG_DIR, 'audit.log');
let DEFAULT_TARGET = process.env.PGSERVE_AUDIT_TARGET || 'file';

/**
 * Override the default log path. Used by tests and by the daemon if it
 * needs to redirect audit output (e.g. when XDG_DATA_HOME is set).
 *
 * @param {{logFile?: string, target?: 'file'|'syslog'}} cfg
 */
export function configureAudit(cfg = {}) {
  if (cfg.logFile) {
    DEFAULT_LOG_PATH = cfg.logFile;
    DEFAULT_LOG_DIR = path.dirname(cfg.logFile);
  }
  if (cfg.target) {
    DEFAULT_TARGET = cfg.target;
  }
}

/**
 * Read pgserve.audit.target from a package.json (returns 'file' if absent).
 * Group 3 calls this per-peer once it has resolved the peer's package.json.
 *
 * @param {string} packageJsonPath
 * @returns {'file'|'syslog'}
 */
export function readAuditTarget(packageJsonPath) {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    const target = pkg?.pgserve?.audit?.target;
    if (target === 'syslog') return 'syslog';
    return 'file';
  } catch {
    return 'file';
  }
}

/**
 * Write one audit event.
 *
 * @param {string} event — one of AUDIT_EVENTS values
 * @param {Record<string, unknown>} [fields] — event-specific payload
 * @param {object} [opts]
 * @param {'file'|'syslog'} [opts.target]
 * @param {string} [opts.logFile]
 */
export function audit(event, fields = {}, opts = {}) {
  if (!VALID_EVENTS.has(event)) {
    throw new Error(`audit: unknown event "${event}". Allowed: ${[...VALID_EVENTS].join(', ')}`);
  }
  const record = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  const target = opts.target || DEFAULT_TARGET;

  if (target === 'syslog') {
    writeSyslog(line);
    return;
  }
  writeFile(line, opts.logFile || DEFAULT_LOG_PATH);
}

function writeFile(line, logFile) {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  rotateIfNeeded(logFile, Buffer.byteLength(line, 'utf8') + 1 /* newline */);
  fs.appendFileSync(logFile, line + '\n', { mode: 0o600 });
}

function rotateIfNeeded(logFile, incomingBytes) {
  let size = 0;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return; // file does not exist yet
  }
  if (size + incomingBytes <= ROTATE_THRESHOLD_BYTES) return;

  // Cascade .N → .(N+1), drop the eldest.
  const oldest = `${logFile}.${ROTATE_KEEP}`;
  if (fs.existsSync(oldest)) {
    fs.unlinkSync(oldest);
  }
  for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
    const src = `${logFile}.${i}`;
    const dst = `${logFile}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  fs.renameSync(logFile, `${logFile}.1`);
}

function writeSyslog(line) {
  // logger -t <tag> is POSIX-standard; spawn detached, do not block.
  // Stderr/stdout discarded — audit must never throw at call sites.
  try {
    const child = spawn('logger', ['-t', 'pgserve-audit', line], {
      stdio: 'ignore',
      detached: false,
    });
    child.on('error', () => { /* logger missing — swallow */ });
  } catch {
    // ENOENT / EACCES — swallow; audit must never break the daemon.
  }
}

/**
 * Internal: expose rotation constants so tests can drive coverage cleanly
 * without depending on actual 50 MB writes.
 */
export const _internals = Object.freeze({
  ROTATE_THRESHOLD_BYTES,
  ROTATE_KEEP,
  rotateIfNeeded,
});
