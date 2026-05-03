/**
 * Step 100 — Schema rename: pgserve_meta → autopg_meta.
 *
 * Group 3 of autopg-distribution-cutover wish. Pre-rename the legacy
 * `public.pgserve_meta` TABLE lives in the `postgres` admin DB; we move it
 * into a new `autopg_meta` SCHEMA (preserving the table name + every row +
 * every index) so the per-fingerprint database tracker remains queryable
 * under the new namespace.
 *
 * Idempotent contract:
 *   - Fresh host (no public.pgserve_meta): create the autopg_meta schema
 *     so subsequent steps (101, Group 5 create-app/list/etc.) have a
 *     home; no table movement required.
 *   - Legacy host (public.pgserve_meta exists): create schema if absent,
 *     then `ALTER TABLE … SET SCHEMA autopg_meta` to relocate. Indexes
 *     follow the table automatically.
 *   - Already-migrated host (autopg_meta.pgserve_meta exists, no
 *     public.pgserve_meta): no-op.
 *
 * Tests inject a mock SQL executor via `__test_internals.setSqlExecutor`
 * to drive the decision matrix without booting a real Postgres.
 */

import { execSync } from 'node:child_process';
import { ADMIN_ROLE, getAdminSecretPath, readAdminSecret } from '../../auth/admin-bootstrap.js';

export const name = 'rename-meta';
const ADMIN_DB = 'postgres';

function getCanonicalPort() {
  const env = process.env.AUTOPG_UPGRADE_PORT || process.env.PGSERVE_PORT;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 8432;
}

function getAdminCreds() {
  try {
    const password = readAdminSecret(getAdminSecretPath());
    return { user: ADMIN_ROLE, password };
  } catch {
    return { user: 'postgres', password: process.env.PGPASSWORD || 'postgres' };
  }
}

function defaultPgQuery({ db = ADMIN_DB, sql, captureStdout = false }) {
  const port = getCanonicalPort();
  const { user, password } = getAdminCreds();
  const env = { ...process.env, PGPASSWORD: password };
  const cmd = `psql -h 127.0.0.1 -p ${port} -U ${user} -d ${db} -At -c ${JSON.stringify(sql)}`;
  return captureStdout
    ? execSync(cmd, { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    : execSync(cmd, { env, stdio: 'pipe' });
}

let _pgQuery = defaultPgQuery;

export const __test_internals = Object.freeze({
  setSqlExecutor(fn) { _pgQuery = fn || defaultPgQuery; },
  resetSqlExecutor() { _pgQuery = defaultPgQuery; },
});

const INSPECT_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'autopg_meta') AS new_schema,
    EXISTS (SELECT 1 FROM information_schema.tables   WHERE table_schema = 'public'      AND table_name = 'pgserve_meta') AS legacy_table,
    EXISTS (SELECT 1 FROM information_schema.tables   WHERE table_schema = 'autopg_meta' AND table_name = 'pgserve_meta') AS migrated_table
`;

function inspectMetaState() {
  const out = _pgQuery({ sql: INSPECT_SQL, captureStdout: true });
  const [newSchema, legacyTable, migratedTable] = String(out).split('|').map((v) => v.trim() === 't');
  return { newSchema, legacyTable, migratedTable };
}

export async function plan() {
  let state;
  try { state = inspectMetaState(); }
  catch (err) { return `cannot inspect schema state: ${err.message}`; }

  if (!state.legacyTable && !state.migratedTable) {
    return state.newSchema
      ? 'autopg_meta schema present, no legacy table to move — no action'
      : 'would CREATE SCHEMA autopg_meta (no legacy table to move)';
  }
  if (state.migratedTable && !state.legacyTable) {
    return 'pgserve_meta already lives in autopg_meta schema — no action';
  }
  if (state.legacyTable && !state.migratedTable) {
    return state.newSchema
      ? 'would ALTER TABLE public.pgserve_meta SET SCHEMA autopg_meta'
      : 'would CREATE SCHEMA autopg_meta + ALTER TABLE public.pgserve_meta SET SCHEMA autopg_meta';
  }
  return 'both public.pgserve_meta and autopg_meta.pgserve_meta exist — would refuse to clobber, manual reconciliation required';
}

export async function execute({ log, warn }) {
  let state;
  try { state = inspectMetaState(); }
  catch (err) { return { status: 'FAIL', detail: `cannot inspect schema state: ${err.message}` }; }

  if (state.legacyTable && state.migratedTable) {
    warn('[rename-meta] both public.pgserve_meta and autopg_meta.pgserve_meta exist — refusing to clobber');
    return { status: 'FAIL', detail: 'duplicate pgserve_meta tables in public + autopg_meta; reconcile manually' };
  }

  if (!state.newSchema) {
    _pgQuery({ sql: 'CREATE SCHEMA IF NOT EXISTS autopg_meta' });
    log('[rename-meta] CREATE SCHEMA autopg_meta');
  }

  if (state.legacyTable && !state.migratedTable) {
    _pgQuery({ sql: 'ALTER TABLE public.pgserve_meta SET SCHEMA autopg_meta' });
    log('[rename-meta] ALTER TABLE public.pgserve_meta SET SCHEMA autopg_meta');
    return { status: 'OK', detail: 'moved public.pgserve_meta → autopg_meta.pgserve_meta' };
  }

  if (state.migratedTable) {
    return { status: 'SKIP', detail: 'autopg_meta.pgserve_meta already present' };
  }

  return { status: 'OK', detail: 'autopg_meta schema ensured (no legacy table to move)' };
}
