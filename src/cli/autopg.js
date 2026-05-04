/**
 * autopg CLI verbs — create-app / list / revoke / rotate (Group 5,
 * autopg-distribution-cutover wish).
 *
 * Provisions per-app SCRAM credentials backed by a per-app role + per-app
 * database, recorded in `autopg_meta.autopg_apps` (Group 3 DDL). The
 * credential is delivered to consumers via `~/.autopg/<app>.env` (mode
 * 0600). Manifest verification (LOCK 1) gates every create-app call —
 * unsigned manifests are rejected unless the operator passes
 * `--unsafe-unverified <INCIDENT_ID>` (loud bypass that writes an audit
 * row tagged with the incident id).
 *
 * Idempotency:
 *   - `create-app` with the same manifest path is a no-op (logs
 *     idempotent-skip + returns 0). Re-running with a *changed* manifest
 *     throws — operator is expected to `revoke` then re-create, OR run
 *     `rotate` when only the credential needs cycling.
 *   - `revoke` is safe to re-run (final state is "no rows in autopg_apps,
 *     no role, no DB, no env file").
 *   - `rotate` is safe to re-run (always writes a fresh password; concurrent
 *     readers see the previous password until the rename atomically flips).
 *
 * Transport:
 *   SQL is shelled out via `psql` — same pattern Group 3 used for the
 *   upgrade steps. Tests inject a mock SQL executor via
 *   `__test_internals.setSqlExecutor`.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
  ADMIN_ROLE,
  getAdminSecretPath,
  getConfigDir,
  readAdminSecret,
} from '../auth/admin-bootstrap.js';
import {
  verifyManifest,
  ManifestVerifyError,
} from '../auth/manifest-verify.js';
import {
  envFilePathFor,
  renderEnvFileBody,
  writeEnvFile,
} from './env-file-writer.js';
import { audit, AUDIT_EVENTS } from '../audit.js';

const ADMIN_DB = 'postgres';
const META_TABLE = 'autopg_meta.autopg_apps';

/**
 * Allow-list of extensions consumers can request via the manifest's
 * `needs.extensions` array. Matches the conservative set Felipe approved
 * for v1 (Sentinel B1: no extension that runs untrusted code from the
 * manifest, no superuser-only extensions).
 */
const EXTENSION_ALLOW_LIST = new Set(['pgvector', 'vector', 'citext', 'pg_trgm', 'uuid-ossp']);

// ─── default (psql shell-out) executor ────────────────────────────────────

function getCanonicalPort() {
  const env = process.env.AUTOPG_PORT || process.env.PGSERVE_PORT;
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
    // First-run / bootstrap-not-yet-done — fall back to bootstrap superuser.
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
    : execSync(cmd, { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

let _pgQuery = defaultPgQuery;

export const __test_internals = Object.freeze({
  setSqlExecutor(fn) { _pgQuery = fn || defaultPgQuery; },
  resetSqlExecutor() { _pgQuery = defaultPgQuery; },
  EXTENSION_ALLOW_LIST,
});

// ─── manifest loader ──────────────────────────────────────────────────────

/**
 * Read + JSON-parse + lightly validate the manifest. Schema enforcement
 * is JSON-Schema-shaped (see `schemas/autopg.json.v1.json`) but kept
 * inline here so the CLI doesn't pull a runtime JSON-Schema dep.
 *
 * @param {string} manifestPath
 * @returns {{app: string, needs: object}}
 */
export function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`autopg: manifest is not valid JSON (${manifestPath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`autopg: manifest must be a JSON object (${manifestPath})`);
  }
  if (typeof parsed.app !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(parsed.app)) {
    throw new Error(`autopg: manifest.app must match /^[a-z][a-z0-9_]{0,62}$/ (${manifestPath})`);
  }
  if (!parsed.needs || typeof parsed.needs !== 'object') {
    throw new Error(`autopg: manifest.needs missing (${manifestPath})`);
  }
  if (typeof parsed.needs.database !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(parsed.needs.database)) {
    throw new Error(`autopg: manifest.needs.database must match /^[a-z][a-z0-9_]{0,62}$/ (${manifestPath})`);
  }
  const exts = parsed.needs.extensions || [];
  if (!Array.isArray(exts)) {
    throw new Error(`autopg: manifest.needs.extensions must be an array (${manifestPath})`);
  }
  for (const ext of exts) {
    if (typeof ext !== 'string' || !EXTENSION_ALLOW_LIST.has(ext)) {
      throw new Error(`autopg: extension "${ext}" not in allow-list ${[...EXTENSION_ALLOW_LIST].join(', ')}`);
    }
  }
  const privs = parsed.needs.privileges || ['crud', 'ddl'];
  if (!Array.isArray(privs) || privs.some((p) => p !== 'crud' && p !== 'ddl')) {
    throw new Error(`autopg: manifest.needs.privileges must be a subset of ["crud","ddl"] (${manifestPath})`);
  }
  return parsed;
}

// ─── identifier guards ────────────────────────────────────────────────────

const SAFE_IDENT = /^[a-z][a-z0-9_]{0,62}$/;

function assertSafeIdent(value, label) {
  if (typeof value !== 'string' || !SAFE_IDENT.test(value)) {
    throw new Error(`autopg: ${label} must match /^[a-z][a-z0-9_]{0,62}$/ (got ${JSON.stringify(value)})`);
  }
}

/**
 * SQL string-literal escape — same shape as admin-bootstrap.js
 * `quoteLiteral`: doubled single quotes, wrap in single quotes. Used only
 * for password values (the role/db identifiers go through SAFE_IDENT
 * + bare interpolation since they're regex-locked).
 */
function quoteLiteral(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function generatePassword() {
  // 32 random bytes, base64url — matches admin-bootstrap.js choice for
  // SCRAM secrets (URL-safe alphabet, no SQL specials).
  return crypto.randomBytes(32).toString('base64url');
}

// ─── DB-state probes ──────────────────────────────────────────────────────

function metaTableExists() {
  const out = _pgQuery({
    sql: "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'autopg_meta' AND table_name = 'autopg_apps')",
    captureStdout: true,
  });
  return String(out).trim() === 't';
}

function appRow(app) {
  const out = _pgQuery({
    sql: `SELECT app, role, db, manifest_sha256, manifest_sig_verified FROM ${META_TABLE} WHERE app = ${quoteLiteral(app)}`,
    captureStdout: true,
  });
  const trimmed = String(out).trim();
  if (!trimmed) return null;
  const [appV, role, db, sha, verified] = trimmed.split('|');
  return {
    app: appV,
    role,
    db,
    manifest_sha256: sha,
    manifest_sig_verified: verified === 't',
  };
}

function roleExists(role) {
  const out = _pgQuery({
    sql: `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)})`,
    captureStdout: true,
  });
  return String(out).trim() === 't';
}

function dbExists(db) {
  const out = _pgQuery({
    sql: `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(db)})`,
    captureStdout: true,
  });
  return String(out).trim() === 't';
}

// ─── provisioning primitives ──────────────────────────────────────────────

function createRoleWithPassword(role, password) {
  assertSafeIdent(role, 'role');
  _pgQuery({
    sql: `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
  });
}

function alterRolePassword(role, password) {
  assertSafeIdent(role, 'role');
  _pgQuery({
    sql: `ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
  });
}

function createDatabaseOwnedBy(db, owner) {
  assertSafeIdent(db, 'db');
  assertSafeIdent(owner, 'owner');
  _pgQuery({ sql: `CREATE DATABASE ${db} OWNER ${owner}` });
}

function grantOnExistingDatabase(db, role, privileges) {
  assertSafeIdent(db, 'db');
  assertSafeIdent(role, 'role');
  // CRUD = data-plane access (TABLES + SEQUENCES). DDL = schema-plane
  // (CREATE on schema). Both default to true unless the manifest narrows.
  const wantCrud = privileges.includes('crud');
  const wantDdl = privileges.includes('ddl');
  _pgQuery({ sql: `GRANT CONNECT ON DATABASE ${db} TO ${role}` });
  if (wantCrud) {
    _pgQuery({ db, sql: `GRANT USAGE ON SCHEMA public TO ${role}` });
    _pgQuery({ db, sql: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}` });
    _pgQuery({ db, sql: `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}` });
    _pgQuery({ db, sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}` });
    _pgQuery({ db, sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}` });
  }
  if (wantDdl) {
    _pgQuery({ db, sql: `GRANT CREATE ON SCHEMA public TO ${role}` });
  }
}

function applyConnectionLimit(role, maxConnections) {
  if (typeof maxConnections !== 'number' || !Number.isFinite(maxConnections) || maxConnections < 1) return;
  assertSafeIdent(role, 'role');
  const n = Math.floor(maxConnections);
  _pgQuery({ sql: `ALTER ROLE ${role} CONNECTION LIMIT ${n}` });
}

function createExtensions(db, extensions) {
  for (const ext of extensions) {
    if (!EXTENSION_ALLOW_LIST.has(ext)) {
      throw new Error(`autopg: extension "${ext}" not in allow-list`);
    }
    // Identifier safety: extension names in allow-list are pre-screened
    // against [a-z0-9_-]; CREATE EXTENSION takes a quoted identifier so
    // we double-quote defensively.
    _pgQuery({ db, sql: `CREATE EXTENSION IF NOT EXISTS "${ext}"` });
  }
}

function upsertMetaRow({ app, role, db, manifestSha256, manifestSigVerified }) {
  _pgQuery({
    sql: `
      INSERT INTO ${META_TABLE} (app, role, db, manifest_sha256, manifest_sig_verified)
      VALUES (${quoteLiteral(app)}, ${quoteLiteral(role)}, ${quoteLiteral(db)}, ${quoteLiteral(manifestSha256)}, ${manifestSigVerified ? 'TRUE' : 'FALSE'})
      ON CONFLICT (app) DO UPDATE SET
        role = EXCLUDED.role,
        db = EXCLUDED.db,
        manifest_sha256 = EXCLUDED.manifest_sha256,
        manifest_sig_verified = EXCLUDED.manifest_sig_verified,
        updated_at = now()
    `,
  });
}

function deleteMetaRow(app) {
  _pgQuery({ sql: `DELETE FROM ${META_TABLE} WHERE app = ${quoteLiteral(app)}` });
}

function dropRoleIfExists(role) {
  assertSafeIdent(role, 'role');
  _pgQuery({ sql: `DROP ROLE IF EXISTS ${role}` });
}

function dropDatabaseIfExists(db) {
  assertSafeIdent(db, 'db');
  _pgQuery({ sql: `DROP DATABASE IF EXISTS ${db}` });
}

// ─── flag parsing ─────────────────────────────────────────────────────────

function parseCreateAppArgs(args) {
  const opts = {
    name: null,
    manifestPath: null,
    adoptExistingDb: null,
    unsafeUnverified: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--manifest') { opts.manifestPath = args[++i]; continue; }
    if (a === '--adopt-existing-db') { opts.adoptExistingDb = args[++i]; continue; }
    if (a === '--unsafe-unverified') { opts.unsafeUnverified = args[++i]; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('-')) {
      throw new Error(`autopg create-app: unknown flag ${a}`);
    }
    if (!opts.name) { opts.name = a; continue; }
    throw new Error(`autopg create-app: unexpected positional argument ${a}`);
  }
  return opts;
}

// ─── verbs ────────────────────────────────────────────────────────────────

function ensureMetaTable() {
  if (!metaTableExists()) {
    throw new Error(
      `autopg: ${META_TABLE} not present — run \`autopg upgrade\` first (Group 3 migration).`,
    );
  }
}

export async function createApp(args, ctx = {}) {
  const out = ctx.stdout || process.stdout;
  const err = ctx.stderr || process.stderr;
  const opts = parseCreateAppArgs(args);
  if (opts.help) {
    out.write(USAGE_CREATE_APP);
    return 0;
  }
  if (!opts.manifestPath) {
    err.write('autopg create-app: --manifest <path> is required\n');
    return 1;
  }

  const manifestPath = path.resolve(opts.manifestPath);
  const manifest = loadManifest(manifestPath);

  // Manifest's app slug wins when no positional name supplied. When both
  // are supplied they must match — operator can't accidentally provision
  // the wrong slug from a copy-pasted manifest.
  const app = opts.name || manifest.app;
  assertSafeIdent(app, 'app');
  if (opts.name && opts.name !== manifest.app) {
    err.write(`autopg create-app: name "${opts.name}" does not match manifest.app "${manifest.app}"\n`);
    return 1;
  }

  // LOCK 1 — verify manifest signature before any provisioning.
  let verifyResult;
  try {
    verifyResult = verifyManifest(manifestPath, {
      unsafeUnverified: opts.unsafeUnverified,
    });
  } catch (e) {
    if (e instanceof ManifestVerifyError) {
      err.write(`autopg create-app: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (verifyResult.bypass) {
    err.write(`autopg create-app: --unsafe-unverified ${verifyResult.bypass} — manifest signature NOT verified (audit row written)\n`);
  }

  ensureMetaTable();

  const db = manifest.needs.database;
  assertSafeIdent(db, 'database');
  const role = app; // role name == app slug for v1; revisit if scope changes
  const privileges = manifest.needs.privileges || ['crud', 'ddl'];
  const extensions = manifest.needs.extensions || [];
  const maxConnections = manifest.needs.quotas?.max_connections;

  const existing = appRow(app);
  if (existing) {
    if (existing.manifest_sha256 === verifyResult.sha256) {
      audit(AUDIT_EVENTS.AUTOPG_APP_IDEMPOTENT_SKIP, {
        app,
        role: existing.role,
        db: existing.db,
        manifest_sha256: verifyResult.sha256,
      });
      out.write(`autopg create-app: ${app} already provisioned (idempotent-skip)\n`);
      return 0;
    }
    err.write(
      `autopg create-app: ${app} already provisioned with a different manifest\n` +
      `  on file: ${existing.manifest_sha256}\n` +
      `  current: ${verifyResult.sha256}\n` +
      `  → run \`autopg revoke ${app}\` then re-create, or \`autopg rotate ${app}\` to cycle creds.\n`,
    );
    return 1;
  }

  // Provisioning order (matters): role → db → grants → extensions → meta row → env file.
  // Failure between any two steps is recoverable with a fresh re-run because
  // each primitive is idempotent against PG state we control.
  const password = generatePassword();

  if (!roleExists(role)) {
    createRoleWithPassword(role, password);
  } else {
    alterRolePassword(role, password);
  }
  applyConnectionLimit(role, maxConnections);

  if (opts.adoptExistingDb) {
    if (opts.adoptExistingDb !== db) {
      err.write(
        `autopg create-app: --adopt-existing-db "${opts.adoptExistingDb}" must match manifest.needs.database "${db}"\n`,
      );
      return 1;
    }
    if (!dbExists(db)) {
      err.write(`autopg create-app: --adopt-existing-db "${db}" not found — cannot adopt a missing database\n`);
      return 1;
    }
    // Adopt: leave owner alone, just GRANT what the manifest needs.
    grantOnExistingDatabase(db, role, privileges);
  } else {
    if (!dbExists(db)) {
      createDatabaseOwnedBy(db, role);
    }
    grantOnExistingDatabase(db, role, privileges);
  }

  createExtensions(db, extensions);

  upsertMetaRow({
    app,
    role,
    db,
    manifestSha256: verifyResult.sha256,
    manifestSigVerified: verifyResult.verified,
  });

  const configDir = ctx.configDir || getConfigDir();
  const envFile = ctx.envFilePath || envFilePathFor(app, configDir);
  writeEnvFile(envFile, renderEnvFileBody({
    role,
    password,
    database: db,
    host: ctx.host || '127.0.0.1',
    port: ctx.port || getCanonicalPort(),
  }));

  audit(AUDIT_EVENTS.AUTOPG_APP_CREATED, {
    app,
    role,
    db,
    manifest_sha256: verifyResult.sha256,
    manifest_sig_verified: verifyResult.verified,
    adopted: Boolean(opts.adoptExistingDb),
  });

  out.write(`autopg create-app: ${app} provisioned (role=${role}, db=${db}, env=${envFile})\n`);
  return 0;
}

export async function listApps(_args, ctx = {}) {
  const out = ctx.stdout || process.stdout;
  ensureMetaTable();
  const raw = _pgQuery({
    sql: `SELECT app, role, db, manifest_sig_verified FROM ${META_TABLE} ORDER BY app`,
    captureStdout: true,
  });
  const lines = String(raw).trim() ? String(raw).trim().split('\n') : [];
  if (lines.length === 0) {
    out.write('autopg list: no apps provisioned\n');
    return 0;
  }
  out.write('app\trole\tdb\tmanifest_sig_verified\n');
  for (const line of lines) {
    const [app, role, db, verified] = line.split('|');
    out.write(`${app}\t${role}\t${db}\t${verified === 't'}\n`);
  }
  return 0;
}

function parseRevokeArgs(args) {
  const opts = { name: null, dropDb: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--drop-db') { opts.dropDb = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('-')) throw new Error(`autopg revoke: unknown flag ${a}`);
    if (!opts.name) { opts.name = a; continue; }
    throw new Error(`autopg revoke: unexpected positional argument ${a}`);
  }
  return opts;
}

export async function revokeApp(args, ctx = {}) {
  const out = ctx.stdout || process.stdout;
  const err = ctx.stderr || process.stderr;
  const opts = parseRevokeArgs(args);
  if (opts.help) { out.write(USAGE_REVOKE); return 0; }
  if (!opts.name) { err.write('autopg revoke: <app> is required\n'); return 1; }
  assertSafeIdent(opts.name, 'app');
  const app = opts.name;

  ensureMetaTable();
  const row = appRow(app);
  // Always remove the env file even if the meta row is absent — recovery
  // from a partial create-app should still wipe the credential.
  const configDir = ctx.configDir || getConfigDir();
  const envFile = ctx.envFilePath || envFilePathFor(app, configDir);
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
  }

  if (!row) {
    out.write(`autopg revoke: ${app} not found in ${META_TABLE} (env file removed if present)\n`);
    return 0;
  }

  // Drop role first (must not be the owner of any object). With the
  // --drop-db flag we drop the DB before the role; without it, we
  // REASSIGN OWNED so the DB survives but the role can be safely
  // dropped.
  if (opts.dropDb) {
    dropDatabaseIfExists(row.db);
  } else if (dbExists(row.db)) {
    // Reassign to admin so DROP ROLE doesn't fail on owned objects.
    _pgQuery({ sql: `REASSIGN OWNED BY ${row.role} TO ${ADMIN_ROLE}` });
    _pgQuery({ sql: `DROP OWNED BY ${row.role}` });
  }
  dropRoleIfExists(row.role);
  deleteMetaRow(app);

  audit(AUDIT_EVENTS.AUTOPG_APP_REVOKED, {
    app,
    role: row.role,
    db: row.db,
    dropped_db: opts.dropDb,
  });
  out.write(`autopg revoke: ${app} removed (role=${row.role}, db=${row.db}${opts.dropDb ? ' [dropped]' : ' [preserved]'})\n`);
  return 0;
}

function parseRotateArgs(args) {
  const opts = { name: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('-')) throw new Error(`autopg rotate: unknown flag ${a}`);
    if (!opts.name) { opts.name = a; continue; }
    throw new Error(`autopg rotate: unexpected positional argument ${a}`);
  }
  return opts;
}

export async function rotateApp(args, ctx = {}) {
  const out = ctx.stdout || process.stdout;
  const err = ctx.stderr || process.stderr;
  const opts = parseRotateArgs(args);
  if (opts.help) { out.write(USAGE_ROTATE); return 0; }
  if (!opts.name) { err.write('autopg rotate: <app> is required\n'); return 1; }
  assertSafeIdent(opts.name, 'app');
  const app = opts.name;

  ensureMetaTable();
  const row = appRow(app);
  if (!row) {
    err.write(`autopg rotate: ${app} not found in ${META_TABLE}\n`);
    return 1;
  }

  const password = generatePassword();
  alterRolePassword(row.role, password);

  const configDir = ctx.configDir || getConfigDir();
  const envFile = ctx.envFilePath || envFilePathFor(app, configDir);
  writeEnvFile(envFile, renderEnvFileBody({
    role: row.role,
    password,
    database: row.db,
    host: ctx.host || '127.0.0.1',
    port: ctx.port || getCanonicalPort(),
  }));

  audit(AUDIT_EVENTS.AUTOPG_APP_ROTATED, {
    app,
    role: row.role,
    db: row.db,
  });
  out.write(`autopg rotate: ${app} credential rotated (env=${envFile})\n`);
  return 0;
}

// ─── usage strings ────────────────────────────────────────────────────────

const USAGE_CREATE_APP = `autopg create-app <name> --manifest <path> [--adopt-existing-db <db>] [--unsafe-unverified <INCIDENT_ID>]

Provision a per-app SCRAM credential backed by a per-app role + per-app DB.
The autopg.json manifest is cosign-verified before any provisioning runs.
On success, writes ~/.autopg/<app>.env (mode 0600) carrying DATABASE_URL.

Flags:
  --manifest <path>            Path to autopg.json (required).
  --adopt-existing-db <name>   Adopt an existing DB (must match manifest.needs.database).
  --unsafe-unverified <ID>     Bypass cosign verification (audit row tags incident <ID>).
`;

const USAGE_REVOKE = `autopg revoke <app> [--drop-db]

Remove the per-app role + meta row + env file. By default the database
survives (objects re-owned by ${ADMIN_ROLE}); pass --drop-db to drop the DB too.
`;

const USAGE_ROTATE = `autopg rotate <app>

Rotate the per-app SCRAM password. The role + DB are unchanged; the env
file is rewritten atomically so concurrent readers never see a partial file.
`;

// ─── dispatcher (called from cli-install.cjs) ─────────────────────────────

const VERBS = {
  'create-app': createApp,
  'list': listApps,
  'revoke': revokeApp,
  'rotate': rotateApp,
};

export async function dispatch(verb, args, ctx) {
  const fn = VERBS[verb];
  if (!fn) {
    (ctx?.stderr || process.stderr).write(`autopg: unknown subcommand "${verb}"\n`);
    return 2;
  }
  try {
    return await fn(args, ctx || {});
  } catch (e) {
    (ctx?.stderr || process.stderr).write(`autopg ${verb}: ${e.message}\n`);
    return 1;
  }
}

// Re-exports for tests that want to drive the surface without mocking
// process streams.
export { USAGE_CREATE_APP, USAGE_REVOKE, USAGE_ROTATE };
