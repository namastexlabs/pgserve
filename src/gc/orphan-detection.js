/**
 * Pure orphan classification for `pgserve gc`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * Splits the gc verb into two halves:
 *   1. (this module)  decide which `pgserve_meta` rows refer to dead
 *      consumers and which are still in use
 *   2. (gc verb)      DROP the orphans + audit-log every drop
 *
 * Keeping classification pure means the gc verb can be tested
 * deterministically (feed in synthetic input → assert the partition)
 * without spinning up postgres, and the rules can be exercised at high
 * fan-out by callers that want a `pgserve gc --dry-run`.
 *
 * Orphan signals (any one is sufficient):
 *   1. The DB row exists in pgserve_meta but the database itself does
 *      not exist in `pg_database` — leftover row from a manual DROP.
 *   2. The row's `source_path` is set and that path no longer exists
 *      on the filesystem — the consumer directory was removed.
 *   3. The row's `last_used_at` is older than `staleAfterMs` AND the
 *      database has zero active connections in `pg_stat_activity`.
 *      The "no connections" guard prevents gc from dropping a DB that
 *      a long-running consumer is actively using; a missing entry in
 *      the activity map is treated as zero connections.
 *
 * Retention signals (none of the above + an explicit "in use" hit):
 *   - `last_used_at` is within the staleness window, OR
 *   - the database has at least one active connection.
 *
 * Inputs:
 *   - `metaRows`         array of pgserve_meta row objects: { fingerprint,
 *                        database_name, role_name, source_path, last_used_at }
 *   - `existingDbs`      Set<string> of DB names from `pg_database`
 *   - `activeDbs`        Set<string> of DB names that have ≥1 row in
 *                        pg_stat_activity (or a Map<string, number> if
 *                        callers want to record the count too — Set-like
 *                        access is what we use)
 *   - `pathExists(path)` callback returning truthy when the path is on
 *                        disk. Caller injects fs.existsSync or a mock.
 *   - `now`              Date — usually `new Date()`; injectable for tests.
 *   - `staleAfterMs`     ms threshold past `last_used_at` to declare
 *                        an idle DB stale. Default: 30 days.
 *
 * Outputs:
 *   { orphans: [...], retained: [...] }
 *   each row in `orphans` has `reason: 'missing_db' | 'missing_path' |
 *   'idle_stale'`; each row in `retained` has `reason: 'active' |
 *   'recent' | 'unknown_meta'`. The `unknown_meta` bucket exists for
 *   rows that are missing `last_used_at` entirely — we never DROP one
 *   of those without an operator decision.
 */

const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * @typedef {Object} MetaRow
 * @property {string}   fingerprint
 * @property {string}   database_name
 * @property {string}   role_name
 * @property {string=}  source_path
 * @property {string|Date=} last_used_at
 */

/**
 * @typedef {Object} OrphanFinding
 * @property {MetaRow}  row
 * @property {'missing_db'|'missing_path'|'idle_stale'} reason
 * @property {string=}  detail
 */

/**
 * @typedef {Object} RetainedFinding
 * @property {MetaRow}  row
 * @property {'active'|'recent'|'unknown_meta'} reason
 * @property {string=}  detail
 */

function asTime(t) {
  if (!t) return null;
  if (t instanceof Date) {
    const ms = t.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  return null;
}

/**
 * Classify a single meta row. Exposed for unit tests so callers can
 * exercise individual signals without composing a full input set.
 *
 * @returns {OrphanFinding | RetainedFinding}
 */
export function classifyRow(row, ctx) {
  if (!row || typeof row.database_name !== 'string' || row.database_name.length === 0) {
    throw new TypeError('classifyRow: row must have a non-empty database_name');
  }
  const {
    existingDbs,
    activeDbs,
    pathExists,
    now,
    staleAfterMs,
  } = ctx;

  // 1. database is gone but the meta row is still here
  if (!existingDbs.has(row.database_name)) {
    return {
      row,
      reason: 'missing_db',
      detail: `${row.database_name} not in pg_database`,
    };
  }

  // 2. consumer directory was removed
  if (typeof row.source_path === 'string' && row.source_path.length > 0) {
    if (!pathExists(row.source_path)) {
      return {
        row,
        reason: 'missing_path',
        detail: `source_path ${row.source_path} no longer exists`,
      };
    }
  }

  // 3. idle + stale
  const lastUsedMs = asTime(row.last_used_at);
  if (lastUsedMs == null) {
    return {
      row,
      reason: 'unknown_meta',
      detail: 'last_used_at is missing or unparseable; refusing to gc without operator review',
    };
  }
  const ageMs = now.getTime() - lastUsedMs;
  const isStale = ageMs >= staleAfterMs;
  const isActive = activeDbs.has(row.database_name);

  if (isActive) {
    return { row, reason: 'active', detail: `${row.database_name} has ≥1 active connection` };
  }
  if (isStale) {
    return {
      row,
      reason: 'idle_stale',
      detail: `last_used_at is ${Math.floor(ageMs / (24 * 60 * 60 * 1000))}d old, no active connections`,
    };
  }
  return { row, reason: 'recent', detail: `last_used_at is within ${Math.floor(staleAfterMs / (24 * 60 * 60 * 1000))}d window` };
}

const ORPHAN_REASONS = new Set(['missing_db', 'missing_path', 'idle_stale']);

/**
 * Partition all rows into orphans + retained.
 * @param {object} args
 * @param {MetaRow[]} args.metaRows
 * @param {Set<string>} args.existingDbs
 * @param {Set<string>} args.activeDbs
 * @param {(p: string) => boolean} [args.pathExists]
 * @param {Date} [args.now]
 * @param {number} [args.staleAfterMs]
 * @returns {{ orphans: OrphanFinding[], retained: RetainedFinding[] }}
 */
export function classifyOrphans(args = {}) {
  const {
    metaRows = [],
    existingDbs = new Set(),
    activeDbs = new Set(),
    pathExists = () => true,
    now = new Date(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
  } = args;
  const ctx = { existingDbs, activeDbs, pathExists, now, staleAfterMs };
  const orphans = [];
  const retained = [];
  for (const row of metaRows) {
    const finding = classifyRow(row, ctx);
    if (ORPHAN_REASONS.has(finding.reason)) orphans.push(finding);
    else retained.push(finding);
  }
  return { orphans, retained };
}

export const __testInternals = Object.freeze({ DEFAULT_STALE_AFTER_MS, asTime });
