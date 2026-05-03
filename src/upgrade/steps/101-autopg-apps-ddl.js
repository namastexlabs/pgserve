/**
 * Step 101 — autopg_meta.autopg_apps DDL.
 *
 * Group 3 of autopg-distribution-cutover wish. Creates the table that
 * backs the new `autopg create-app / list / revoke / rotate` CLI verbs
 * (Group 5). Each row records one provisioned consumer app: its dedicated
 * SCRAM role, owned database, and the SHA-256 of the autopg.json manifest
 * the app was provisioned from (plus a flag attesting that the manifest
 * cosign signature was verified at provision time per LOCK 1).
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS — safe to re-run on every
 * upgrade. Depends on step 100 having created the autopg_meta schema.
 *
 * Tests inject a mock SQL executor via `__test_internals.setSqlExecutor`.
 */

import { execSync } from 'node:child_process';
import { ADMIN_ROLE, getAdminSecretPath, readAdminSecret } from '../../auth/admin-bootstrap.js';

export const name = 'autopg-apps-ddl';
const ADMIN_DB = 'postgres';

export const APPS_DDL = `
  CREATE TABLE IF NOT EXISTS autopg_meta.autopg_apps (
    app                   TEXT PRIMARY KEY,
    role                  TEXT NOT NULL,
    db                    TEXT NOT NULL,
    manifest_sha256       TEXT NOT NULL,
    manifest_sig_verified BOOLEAN NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

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

function tableExists() {
  const out = _pgQuery({
    sql: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'autopg_meta' AND table_name = 'autopg_apps')",
    captureStdout: true,
  });
  return String(out).trim() === 't';
}

function schemaExists() {
  const out = _pgQuery({
    sql: "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'autopg_meta')",
    captureStdout: true,
  });
  return String(out).trim() === 't';
}

export async function plan() {
  let present;
  try { present = tableExists(); }
  catch (err) { return `cannot inspect autopg_meta.autopg_apps: ${err.message}`; }
  return present
    ? 'autopg_meta.autopg_apps already present, no action needed'
    : 'would CREATE TABLE IF NOT EXISTS autopg_meta.autopg_apps (...)';
}

export async function execute({ log }) {
  if (!schemaExists()) {
    return { status: 'FAIL', detail: 'autopg_meta schema missing — run step 100 first' };
  }
  if (tableExists()) {
    return { status: 'SKIP', detail: 'autopg_meta.autopg_apps already present' };
  }
  _pgQuery({ sql: APPS_DDL });
  log('[autopg-apps-ddl] CREATE TABLE autopg_meta.autopg_apps');
  return { status: 'OK', detail: 'created autopg_meta.autopg_apps' };
}
