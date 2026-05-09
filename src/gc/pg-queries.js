/**
 * psql shellout helpers for `pgserve gc`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3
 * (the `pgserve gc` orchestration layer).
 *
 * Why psql shellout vs. node-postgres:
 *   - matches the existing pattern in
 *     `src/upgrade/steps/cosign-meta-migration.js#pgQuery` (PR #79).
 *   - avoids the runtime cost of loading the `pg` driver in a CLI verb
 *     that runs once and exits.
 *   - no shell expansion: SQL goes through stdin, not a template string,
 *     so postgres-style `$$` blocks survive intact.
 *
 * All queries connect over TCP to 127.0.0.1:<port> as `postgres`. The
 * port comes from `~/.autopg/admin.json` (canonical 5432) and falls
 * back to the postgres default. The connection-discovery layer keeps
 * `<socketDir>/runtime.json` available too — gc could prefer a Unix
 * socket on the supervised host — but the upgrade pipeline already
 * uses TCP loopback, and matching its surface keeps test fixtures
 * single-form.
 *
 * DROP DATABASE caveat: postgres refuses `DROP DATABASE <db>` when
 * sessions are connected. We `pg_terminate_backend()` everything
 * targeting the doomed database first, then DROP. The kill step is
 * gated behind explicit `--apply` at the CLI layer; this module just
 * exposes the primitives.
 */

import { spawnSync } from 'node:child_process';

import { PGSERVE_META_TABLE } from '../schema/pgserve-meta.js';

const DEFAULT_PORT = 5432;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_USER = 'postgres';
const DEFAULT_DB = 'postgres';

const SYSTEM_DBS = new Set(['template0', 'template1', 'postgres']);

/**
 * Run a single SQL statement via psql, fed through stdin (no shell
 * expansion). Throws on non-zero exit. Returns stdout (trimmed when
 * `captureStdout`).
 */
export function pgQuery({
  sql,
  db = DEFAULT_DB,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  user = DEFAULT_USER,
  password = process.env.PGPASSWORD || 'postgres',
  captureStdout = false,
} = {}) {
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new TypeError('pgQuery: sql must be a non-empty string');
  }
  const env = { ...process.env, PGPASSWORD: password };
  const result = spawnSync(
    'psql',
    ['-h', host, '-p', String(port), '-U', user, '-d', db, '-At', '-f', '-'],
    { env, input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr || Buffer.from('')).toString();
    const err = new Error(`psql exited ${result.status}: ${stderr.trim()}`);
    err.status = result.status;
    err.stderr = stderr;
    throw err;
  }
  const stdout = (result.stdout || Buffer.from('')).toString();
  return captureStdout ? stdout.trim() : stdout;
}

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

// ─── identifier / literal quoting ─────────────────────────────────────
//
// We do NOT use psql's :'name' substitution because that requires
// passing args separately, and `pgQuery` uses stdin. The identifiers
// we interpolate are constrained:
//   - database_name / role_name come from src/provision/db-naming.js
//     which produces /[a-z0-9_]+/ slugs ≤63 chars.
//   - fingerprint is a sha256-hex from src/provision/fingerprint.js
//     OR an operator-pinned literal that passed validateEntry.
// Even so, we quote defensively — an admin who manually inserted a
// row with a quote in it shouldn't crash gc.

function quoteIdent(name) {
  // Postgres identifier quoting: wrap in "..." and escape internal ".
  return `"${String(name).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  // Postgres literal quoting: wrap in '...' and escape internal '.
  return `'${String(value).replace(/'/g, "''")}'`;
}

export const __testInternals = Object.freeze({
  quoteIdent,
  quoteLiteral,
  SYSTEM_DBS,
  DEFAULT_PORT,
});
