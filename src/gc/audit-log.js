/**
 * Append-only audit log writer for `pgserve gc`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * The wish acceptance criteria require gc to "audit-log every drop" so
 * that an operator can answer "why did my database disappear?" days
 * later. We keep the format intentionally boring: one JSON object per
 * line at `~/.pgserve/audit/gc-<YYYY-MM-DD>.log`, opened with O_APPEND
 * so multiple gc runs on the same day interleave cleanly.
 *
 * One JSON object per event so logs are streamable through tools that
 * expect JSON-lines (jq, fluent-bit, vector, etc.) without a second
 * parser. UTC date in the filename so log rotation across timezones is
 * deterministic.
 *
 * Permissions: dir 0700, file 0600 — same posture as the cosign cache
 * tokens. Audit logs may name databases that contain sensitive tenant
 * identifiers; tightening file mode is cheap insurance.
 *
 * Pure-ish: filesystem I/O is the side effect. No postgres, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUDIT_DIR_NAME = 'audit';
export const AUDIT_FILE_PREFIX = 'gc-';
export const AUDIT_FILE_MODE = 0o600;
export const AUDIT_DIR_MODE = 0o700;

/**
 * @typedef {Object} GcAuditEvent
 * @property {string}  ts            ISO 8601 timestamp with ms.
 * @property {'drop'|'skip'|'error'|'start'|'finish'} action
 * @property {string=} fingerprint   pgserve_meta.fingerprint
 * @property {string=} database      database name acted on
 * @property {string=} role          role name acted on
 * @property {string=} reason        finding.reason from orphan detection
 *                                   ('missing_db' | 'missing_path' | …)
 *                                   or a free-form skip / error reason.
 * @property {string=} detail        operator-facing detail line.
 * @property {string=} dryRun        present when --dry-run; the audit
 *                                   line then records what *would* have
 *                                   happened.
 */

export function getAuditDir({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, '.pgserve', AUDIT_DIR_NAME);
}

/**
 * Build the audit-file path for a given UTC date. Defaults to "today".
 */
export function getAuditFilePath({ homeDir = os.homedir(), date = new Date() } = {}) {
  const yyyyMmDd = formatUtcDate(date);
  return path.join(getAuditDir({ homeDir }), `${AUDIT_FILE_PREFIX}${yyyyMmDd}.log`);
}

function formatUtcDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('formatUtcDate: date must be a valid Date');
  }
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Append a single gc audit event. Returns the line that was written
 * (without the trailing newline) so callers can mirror it to stdout.
 *
 * @param {GcAuditEvent} event
 * @param {object} [opts]
 * @param {string} [opts.homeDir]   override for tests
 * @param {Date}   [opts.date]      override for tests; defaults to now
 */
export function writeGcAudit(event, opts = {}) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('writeGcAudit: event must be an object');
  }
  if (typeof event.action !== 'string' || event.action.length === 0) {
    throw new TypeError('writeGcAudit: event.action is required');
  }
  const dir = getAuditDir(opts);
  const file = getAuditFilePath(opts);
  fs.mkdirSync(dir, { recursive: true, mode: AUDIT_DIR_MODE });
  // mkdirSync's `mode` only applies on creation. If the audit dir was
  // previously created with a looser umask (older gc versions, manual
  // mkdir -p, restored backup) it stays at whatever mode it had —
  // tighten it to 0700 to match the file-side belt-and-suspenders.
  try {
    fs.chmodSync(dir, AUDIT_DIR_MODE);
  } catch {
    /* best-effort on platforms that ignore chmod */
  }
  // ts must be the canonical ISO 8601 string unless the caller supplied
  // a non-empty string (correlation-id use case). The spread MUST come
  // first so a stray `ts: undefined` / `ts: 0` / `ts: new Date()` from
  // the caller cannot silently overwrite our generated value — JS
  // object-spread precedence means later keys win. (Earlier shape had
  // this inverted with a wrong comment claiming the spread "doesn't
  // overwrite" — it does.)
  const enriched = {
    ...event,
    ts: typeof event.ts === 'string' && event.ts ? event.ts : new Date().toISOString(),
  };
  const line = JSON.stringify(enriched);
  fs.appendFileSync(file, line + '\n', { mode: AUDIT_FILE_MODE });
  // appendFileSync's `mode` only applies on file creation; chmod the
  // existing file to be safe in case it was previously created with a
  // looser umask (older gc versions, manual touches, etc.).
  try {
    fs.chmodSync(file, AUDIT_FILE_MODE);
  } catch {
    /* best-effort on platforms that ignore chmod */
  }
  return line;
}

/**
 * Read all events for a single UTC date. Returns parsed objects; lines
 * that fail to parse are returned as `{ malformed: true, raw: <line> }`
 * so a corrupt earlier write doesn't make the rest of the file
 * unreadable. Missing file → empty array.
 */
export function readGcAuditDay({ homeDir = os.homedir(), date = new Date() } = {}) {
  const file = getAuditFilePath({ homeDir, date });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ malformed: true, raw: line });
    }
  }
  return out;
}

export const __testInternals = Object.freeze({ formatUtcDate });
