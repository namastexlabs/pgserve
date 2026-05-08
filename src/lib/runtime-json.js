/**
 * `<socketDir>/runtime.json` — runtime discovery file owned by the
 * `autopg serve` postmaster wrapper (cutover wish G19).
 *
 * Schema:
 *   {
 *     socketDir:     "<absolute path>",
 *     port:          <integer>,    // postgres TCP port
 *     pid:           <integer>,    // postmaster pid
 *     autopgPid:     <integer>,    // `autopg serve` wrapper pid
 *     schemaVersion: 1
 *   }
 *
 * Cohort contract — there is **no `supervisor` field**. The supervisor
 * (pm2 / systemd-user / launchd / external) is recorded once at install
 * time in `~/.autopg/admin.json`. Mixing the two creates a synchronization
 * problem (which file is authoritative when the postmaster restarts under
 * a new pid?). `writeRuntimeJson()` rejects records carrying a `supervisor`
 * key so the contract can't drift via a future copy-paste.
 *
 * Lifecycle:
 *   - `writeRuntimeJson()` after the postmaster greets healthy.
 *   - `clearRuntimeJson()` on graceful shutdown (SIGTERM / SIGINT).
 *   - On crash the file is left in place. Consumers detect a stale record
 *     via `process.kill(record.autopgPid, 0)` (no-signal probe).
 *
 * Atomic semantics: write to `<file>.tmp.<pid>`, then `fs.renameSync()`.
 * Mode 0644 so unprivileged peers can `cat <socketDir>/runtime.json`
 * without sudo — the file carries no secrets, only public discovery info.
 */

import fs from 'fs';
import path from 'path';

export const RUNTIME_FILE_NAME = 'runtime.json';
export const RUNTIME_FILE_MODE = 0o644;
export const RUNTIME_SCHEMA_VERSION = 1;

export function getRuntimeFilePath(socketDir) {
  if (typeof socketDir !== 'string' || socketDir.length === 0) {
    throw new TypeError('runtime-json: socketDir must be a non-empty string');
  }
  return path.join(socketDir, RUNTIME_FILE_NAME);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateRecord(record) {
  if (!isPlainObject(record)) {
    throw new TypeError('runtime-json: record must be an object');
  }
  if (typeof record.socketDir !== 'string' || record.socketDir.length === 0) {
    throw new TypeError('runtime-json: socketDir must be a non-empty string');
  }
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
    throw new TypeError(`runtime-json: port must be an integer in [1, 65535]; got ${record.port}`);
  }
  if (!Number.isInteger(record.pid) || record.pid < 1) {
    throw new TypeError(`runtime-json: pid must be a positive integer; got ${record.pid}`);
  }
  if (!Number.isInteger(record.autopgPid) || record.autopgPid < 1) {
    throw new TypeError(`runtime-json: autopgPid must be a positive integer; got ${record.autopgPid}`);
  }
  if (Object.prototype.hasOwnProperty.call(record, 'supervisor')) {
    throw new TypeError(
      'runtime-json: refusing to write `supervisor` into runtime.json — that field '
      + 'lives only in `~/.autopg/admin.json` (cohort contract).',
    );
  }
}

/**
 * Read `<socketDir>/runtime.json`. Returns the parsed object on success,
 * `null` when the file is missing or unreadable. Never throws — callers
 * treat "missing" and "broken" identically and fall back to admin.json.
 */
export function readRuntimeJson(socketDir) {
  let file;
  try {
    file = getRuntimeFilePath(socketDir);
  } catch {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic write of the runtime discovery record. Validates shape, refuses
 * a `supervisor` key (the cohort contract — that field belongs in
 * admin.json), ensures the parent directory exists, and stamps
 * `schemaVersion: 1` if the caller didn't.
 */
export function writeRuntimeJson(input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('runtime-json: writeRuntimeJson expects an object argument');
  }
  // Reject `supervisor` from the input directly — destructuring would
  // silently drop it and that's a contract failure we want to surface.
  if (Object.prototype.hasOwnProperty.call(input, 'supervisor')) {
    throw new TypeError(
      'runtime-json: refusing to write `supervisor` into runtime.json — that field '
      + 'lives only in `~/.autopg/admin.json` (cohort contract).',
    );
  }
  const { socketDir, port, pid, autopgPid, schemaVersion = RUNTIME_SCHEMA_VERSION } = input;
  const record = { socketDir, port, pid, autopgPid, schemaVersion };
  validateRecord(record);

  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }

  const file = getRuntimeFilePath(socketDir);
  const tmp = `${file}.tmp.${process.pid}`;
  const json = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(tmp, json, { mode: RUNTIME_FILE_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, RUNTIME_FILE_MODE);
  return record;
}

/**
 * Best-effort delete of `<socketDir>/runtime.json`. Used during graceful
 * shutdown so consumers immediately observe "no live postmaster" instead
 * of seeing a stale-pid record they have to probe with `process.kill()`.
 *
 * Returns `true` when the file was removed, `false` when it was already
 * gone or removal failed. Never throws — graceful shutdown must not
 * regress because of a permission glitch on the runtime file.
 */
export function clearRuntimeJson(socketDir) {
  let file;
  try {
    file = getRuntimeFilePath(socketDir);
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when the runtime record points at a process that's alive
 * on this host. `process.kill(pid, 0)` is a no-signal probe — it raises
 * ESRCH when the pid is gone and EPERM when we can't signal a foreign
 * uid (still alive, just not ours). Treat EPERM as "alive" so cross-uid
 * supervisors (e.g. an operator probing a system-installed pgserve)
 * don't false-negative.
 */
export function isLiveRuntime(record) {
  if (!isPlainObject(record)) return false;
  // process.kill(pid, 0) accepts a process group sentinel for pid <= 0
  // (pid 0 = caller's group, pid -1 = every signalable process). Neither
  // is a meaningful "live postmaster" answer, so reject anything below 1
  // before we touch the syscall.
  const pid = record.autopgPid;
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}
