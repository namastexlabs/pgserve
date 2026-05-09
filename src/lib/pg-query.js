/**
 * Shared psql shellout primitive.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3
 * (foundation for the gc + provision orchestration verbs).
 *
 * Why psql shellout vs. node-postgres:
 *   - matches the existing pattern in
 *     `src/upgrade/steps/cosign-meta-migration.js` (PR #79).
 *   - avoids the runtime cost of loading the `pg` driver in a CLI
 *     verb that runs once and exits.
 *   - no shell expansion: SQL goes through stdin, not a template
 *     string, so postgres-style `$$` blocks survive intact.
 *
 * Caller-supplied `db` defaults to `postgres`. The connection-discovery
 * layer (admin.json + runtime.json) is the caller's responsibility —
 * this module does not assume a host shape.
 */

import { spawnSync } from 'node:child_process';

export const PG_QUERY_DEFAULTS = Object.freeze({
  port: 5432,
  host: '127.0.0.1',
  user: 'postgres',
  db: 'postgres',
});

/**
 * Run a single SQL statement (or batch) via psql, fed through stdin
 * (no shell expansion). Throws on non-zero exit. Returns stdout
 * (trimmed when `captureStdout`).
 *
 * @param {object} args
 * @param {string} args.sql                      SQL to execute
 * @param {string} [args.db='postgres']          target database
 * @param {number} [args.port=5432]              postgres port
 * @param {string} [args.host='127.0.0.1']       postgres host
 * @param {string} [args.user='postgres']        postgres user
 * @param {string} [args.password]               PGPASSWORD; defaults to
 *                                               `process.env.PGPASSWORD`
 *                                               or 'postgres'
 * @param {boolean} [args.captureStdout=false]   trim + return stdout
 * @returns {string} stdout (trimmed when `captureStdout`)
 */
export function pgQuery({
  sql,
  db = PG_QUERY_DEFAULTS.db,
  port = PG_QUERY_DEFAULTS.port,
  host = PG_QUERY_DEFAULTS.host,
  user = PG_QUERY_DEFAULTS.user,
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
 * Postgres identifier quoting: wrap in "..." and escape internal ".
 * Used by callers that interpolate identifiers (DDL doesn't accept
 * parameter binding for table / role / database names).
 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Postgres literal quoting: wrap in '...' and escape internal '.
 * Use this for any string literal that ends up in a DDL string;
 * regular DML should bind parameters instead, but psql's stdin form
 * doesn't accept those, so the safe path for our shellout is to
 * always quoteLiteral defensively.
 */
export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
