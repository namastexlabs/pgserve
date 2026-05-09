/**
 * psql query helpers for `pgserve gc`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3
 * (the `pgserve gc` orchestration layer).
 *
 * This module composes the shared psql primitive (`pgQuery` /
 * `quoteIdent` / `quoteLiteral` from `src/lib/pg-query.js`) into the
 * specific SELECT / DROP queries gc runs against `pgserve_meta` +
 * `pg_database` + `pg_stat_activity`.
 *
 * Earlier shape (PR #91) inlined its own `pgQuery` because the shared
 * lib didn't exist on main yet — PR #92 added `src/lib/pg-query.js`,
 * and the `autopg-distribution-cutover-finalize` G2 dedup (this file's
 * commit) deletes the inline copy and imports the shared one.
 *
 * DROP DATABASE caveat: postgres refuses `DROP DATABASE <db>` when
 * sessions are connected. We `pg_terminate_backend()` everything
 * targeting the doomed database first, then DROP. The kill step is
 * gated behind explicit `--apply` at the CLI layer; this module just
 * exposes the primitives.
 */

import { pgQuery, quoteIdent, quoteLiteral, PG_QUERY_DEFAULTS } from '../lib/pg-query.js';
import { PGSERVE_META_TABLE } from '../schema/pgserve-meta.js';

const DEFAULT_PORT = PG_QUERY_DEFAULTS.port;
const DEFAULT_DB = PG_QUERY_DEFAULTS.db;

const SYSTEM_DBS = new Set(['template0', 'template1', 'postgres']);

// Re-export the shared primitive so existing callers that imported
// `pgQuery` from `src/gc/pg-queries.js` keep working without churn.
// Future PRs can switch them to import directly from `src/lib/pg-query.js`.
export { pgQuery };

/**
 * SELECT every row from `pgserve_meta`. Returns an array of plain
 * objects matching the table shape from `src/schema/pgserve-meta.js`.
 * Throws ENOPGSERVE_META if the table doesn't exist (caller decides
 * whether that's a "no provisions yet" warn vs. a hard fail).
 */
export function selectMetaRows({ port = DEFAULT_PORT } = {}) {
  // Single-line tab-separated form so a missing/null column still
  // parses cleanly. ARRAY_AGG would lose null distinction.
  const exists = pgQuery({
    db: DEFAULT_DB,
    port,
    sql: `SELECT to_regclass('public.${PGSERVE_META_TABLE}') IS NOT NULL`,
    captureStdout: true,
  });
  if (exists.trim() !== 't') {
    const err = new Error(`pgserve_meta does not exist on this host`);
    err.code = 'ENOPGSERVE_META';
    throw err;
  }
  const out = pgQuery({
    db: DEFAULT_DB,
    port,
    sql: [
      'SELECT',
      "  COALESCE(fingerprint, ''),",
      "  COALESCE(database_name, ''),",
      "  COALESCE(role_name, ''),",
      "  COALESCE(publisher, ''),",
      "  COALESCE(source_path, ''),",
      "  COALESCE(to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), '')",
      `FROM public.${PGSERVE_META_TABLE}`,
      'ORDER BY fingerprint',
    ].join('\n'),
    captureStdout: true,
  });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [fingerprint, database_name, role_name, publisher, source_path, last_used_at] = line.split('\t');
    return {
      fingerprint: fingerprint || '',
      database_name: database_name || '',
      role_name: role_name || '',
      publisher: publisher || '',
      source_path: source_path || '',
      // Empty string → undefined so orphan-detection's `unknown_meta`
      // bucket triggers correctly when last_used_at was NULL on disk.
      last_used_at: last_used_at && last_used_at.length > 0 ? last_used_at : undefined,
    };
  });
}

/**
 * SELECT every non-template database name from pg_database. Excludes
 * the postgres-system DBs ('template0', 'template1', 'postgres').
 */
export function selectExistingDbs({ port = DEFAULT_PORT } = {}) {
  const out = pgQuery({
    db: DEFAULT_DB,
    port,
    sql: 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname',
    captureStdout: true,
  });
  if (!out) return new Set();
  const arr = out.split('\n').filter(Boolean).filter((d) => !SYSTEM_DBS.has(d));
  return new Set(arr);
}

/**
 * Return the set of DB names that have ≥1 active connection in
 * pg_stat_activity (excluding our own connection).
 */
export function selectActiveDbs({ port = DEFAULT_PORT } = {}) {
  const out = pgQuery({
    db: DEFAULT_DB,
    port,
    sql: [
      'SELECT DISTINCT datname',
      'FROM pg_stat_activity',
      'WHERE datname IS NOT NULL',
      '  AND pid <> pg_backend_pid()',
    ].join('\n'),
    captureStdout: true,
  });
  if (!out) return new Set();
  return new Set(out.split('\n').filter(Boolean));
}

/**
 * Terminate every backend connected to `database`, then `DROP DATABASE`
 * + `DROP ROLE IF EXISTS`. Caller is responsible for orphan
 * classification — this is the dumb side. We commit each drop in its
 * own implicit transaction (psql -At -f - is autocommit) so a partial
 * sweep leaves a consistent audit log.
 *
 * Returns `{ database, role }` for the audit writer.
 */
export function dropDatabase({ database, role, port = DEFAULT_PORT } = {}) {
  if (typeof database !== 'string' || database.length === 0 || SYSTEM_DBS.has(database)) {
    throw new Error(`dropDatabase: refusing to drop "${database}" (empty or system DB)`);
  }
  // 1. Disconnect everything from the doomed DB. SELECT-with-side-
  //    effect form so we can run it from any other DB.
  pgQuery({
    db: DEFAULT_DB,
    port,
    sql: [
      'SELECT pg_terminate_backend(pid)',
      'FROM pg_stat_activity',
      `WHERE datname = ${quoteLiteral(database)}`,
      '  AND pid <> pg_backend_pid()',
    ].join('\n'),
  });
  // 2. DROP DATABASE — postgres rejects parameterized DDL, so we have
  //    to interpolate. database_name comes from pgserve_meta (which we
  //    write ourselves via deriveProvisionedNames) and SYSTEM_DBS is
  //    guarded above; the identifier surface is constrained.
  pgQuery({
    db: DEFAULT_DB,
    port,
    sql: `DROP DATABASE IF EXISTS ${quoteIdent(database)}`,
  });
  // 3. DROP ROLE — best-effort; a role may be shared across multiple
  //    DBs in older non-cohort installs, so we use IF EXISTS and don't
  //    fail the gc run if it can't be dropped (other DBs depend on it).
  if (typeof role === 'string' && role.length > 0) {
    try {
      pgQuery({
        db: DEFAULT_DB,
        port,
        sql: `DROP ROLE IF EXISTS ${quoteIdent(role)}`,
      });
    } catch {
      /* role may be in use elsewhere; not fatal for gc's drop step */
    }
  }
  return { database, role };
}

/**
 * DELETE the row from `pgserve_meta`. Caller invokes after a successful
 * `dropDatabase` so the next gc run doesn't re-find the same orphan.
 */
export function deleteMetaRow({ fingerprint, port = DEFAULT_PORT } = {}) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('deleteMetaRow: fingerprint must be a non-empty string');
  }
  pgQuery({
    db: DEFAULT_DB,
    port,
    sql: `DELETE FROM public.${PGSERVE_META_TABLE} WHERE fingerprint = ${quoteLiteral(fingerprint)}`,
  });
}

// quoteIdent + quoteLiteral are imported from `src/lib/pg-query.js` —
// the dedup keeps gc and provision quoting identical (same primitive,
// same defensive escapes).

export const __testInternals = Object.freeze({
  quoteIdent,
  quoteLiteral,
  SYSTEM_DBS,
  DEFAULT_PORT,
});
