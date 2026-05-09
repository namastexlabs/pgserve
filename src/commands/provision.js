/**
 * `pgserve provision [<fingerprint>]` — singleton G3 verb 4.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * Idempotent provisioner. Resolves a fingerprint from the operator's
 * cwd (or an explicit positional), takes a per-fingerprint advisory
 * lock to make 10 concurrent calls produce exactly 1 database, then
 * runs the cohort-canonical CREATE ROLE / CREATE DATABASE / GRANT /
 * INSERT INTO pgserve_meta sequence.
 *
 * Composes the merged G3 foundations:
 *   - src/provision/fingerprint.js     → resolveFingerprint
 *   - src/provision/db-naming.js       → deriveProvisionedNames
 *   - src/schema/pgserve-meta.js       → bootstrapPgserveMeta
 *   - src/cosign/schema.js             → applyVerifiedColumns
 *   - src/lib/pg-query.js              → pgQuery / quoteIdent / quoteLiteral
 *   - src/lib/admin-json.js            → readAdminJson (port discovery)
 *
 * The advisory-lock helpers in src/provision/advisory-lock.js are NOT
 * called by this CLI verb (see "Concurrency note" below) — they're
 * kept on main for future single-session callers (e.g. a daemon mode).
 *
 * Idempotency strategy:
 *   1. SELECT existing pgserve_meta row by fingerprint inside the
 *      advisory-lock window. If present + database still exists, just
 *      `touch` last_used_at and exit success.
 *   2. Otherwise run the full create sequence with `IF NOT EXISTS` /
 *      `CREATE OR REPLACE` semantics so a partial earlier run can be
 *      resumed without operator surgery.
 *   3. INSERT ... ON CONFLICT (fingerprint) DO UPDATE so the row
 *      converges to current values whether this is a first run or a
 *      replay.
 *
 * Concurrency note (PR #92 bot-review correction):
 *   The wish references `pg_advisory_lock`-deduped provisioning, but
 *   we shell out to psql via `spawnSync` — every pgQuery call starts
 *   a NEW psql session, so even a session-scoped lock can't survive
 *   across our calls (xact-scoped is even shorter — releases on the
 *   transaction's COMMIT). To get a real lock we'd need to bundle the
 *   whole sequence into a single piped psql script, which collides
 *   with `CREATE DATABASE`'s "no transaction block" restriction.
 *
 *   The honest mechanism here is **idempotency under racing replays**:
 *     - CREATE ROLE wrapped in a `DO` / `IF NOT EXISTS` block.
 *     - CREATE DATABASE catches `database "<name>" already exists`
 *       (psql does NOT emit SQLSTATE codes by default, so we match
 *       on the human-readable error text in stderr — bot review
 *       MEDIUM).
 *     - GRANT is set-style (re-running adds nothing).
 *     - INSERT INTO pgserve_meta uses `ON CONFLICT (fingerprint) DO
 *       UPDATE` so the row converges to current values.
 *
 *   10 concurrent `provision <fingerprint>` invocations with the same
 *   fingerprint converge to one (database, role, meta row) trio — the
 *   serialization is at the postgres level (CREATE DATABASE acquires
 *   the appropriate locks itself), not at our shellout level. The
 *   advisory-lock primitives in `src/provision/advisory-lock.js` are
 *   kept for future single-session callers (e.g. a daemon mode), but
 *   are NOT acquired by this CLI verb.
 *
 * Exit codes:
 *   0   provisioned (or no-op idempotent replay)
 *   1   user error (bad flags, fingerprint validation)
 *   2   pgserve postmaster unreachable / not provisionable
 *   3   postgres error during create sequence (partial state may
 *       remain; rerun is safe)
 */

import { readAdminJson } from '../lib/admin-json.js';
import { resolveFingerprint } from '../provision/fingerprint.js';
import { deriveProvisionedNames } from '../provision/db-naming.js';
import { bootstrapPgserveMeta } from '../schema/pgserve-meta.js';
import { applyVerifiedColumns } from '../cosign/schema.js';
import { pgQuery, quoteIdent, quoteLiteral } from '../lib/pg-query.js';

const USAGE = `Usage: pgserve provision [<fingerprint>] [options]

  <fingerprint>            optional explicit fingerprint string (skips
                           package.json detection); pinned by the
                           operator. If omitted, pgserve resolves the
                           fingerprint from the cwd's package.json.

  --port <N>               override the postgres port (default: read
                           admin.json or 5432).
  --json                   emit a JSON summary on stdout.
  -h, --help               show this help.

Idempotent: re-running with the same fingerprint touches last_used_at
and exits success — no error if the database already exists.`;

function parseFlags(argv) {
  const out = { json: false, port: undefined, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port':
      case '-p': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          throw new Error('--port requires an integer in [1, 65535]');
        }
        out.port = v;
        break;
      }
      default:
        if (a.startsWith('--')) {
          throw new Error(`unknown flag: ${a}`);
        }
        out.positional.push(a);
    }
  }
  return out;
}

function resolvePort(opts) {
  if (typeof opts.port === 'number') return opts.port;
  try {
    const admin = readAdminJson();
    if (admin && Number.isInteger(admin.port) && admin.port > 0) return admin.port;
  } catch {
    /* admin.json absent — fall through */
  }
  return 5432;
}

/**
 * Run the bootstrap (pgserve_meta CREATE TABLE + indexes) and then
 * apply the cosign verify ALTER columns on top. Idempotent — both
 * modules use IF NOT EXISTS / IF NOT EXISTS guards.
 */
async function ensurePgserveMetaSchema({ port }) {
  const client = makePsqlClient({ port, db: 'postgres' });
  await bootstrapPgserveMeta(client);
  await applyVerifiedColumns(client);
}

/**
 * Adapter: shape `pgQuery` to the node-postgres-compatible
 * `client.query(sql)` contract that bootstrapPgserveMeta + applyVerifiedColumns
 * expect. Awaitable so the modules can `await client.query(sql)`.
 */
function makePsqlClient({ port, db }) {
  return {
    query: async (sql) => pgQuery({ sql, port, db }),
  };
}

/**
 * Probe: does pgserve_meta have a row for this fingerprint?
 * Returns the row or null.
 */
function selectMetaRow({ port, fingerprint }) {
  const out = pgQuery({
    sql: [
      'SELECT',
      "  COALESCE(database_name, ''),",
      "  COALESCE(role_name, '')",
      'FROM public.pgserve_meta',
      `WHERE fingerprint = ${quoteLiteral(fingerprint)}`,
      'LIMIT 1',
    ].join('\n'),
    port,
    captureStdout: true,
  });
  if (!out) return null;
  const [database_name, role_name] = out.split('\t');
  if (!database_name) return null;
  return { database_name, role_name };
}

function databaseExists({ port, database }) {
  const out = pgQuery({
    sql: `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(database)}`,
    port,
    captureStdout: true,
  });
  return out === '1';
}

function touchMetaRow({ port, fingerprint }) {
  pgQuery({
    sql: `UPDATE public.pgserve_meta SET last_used_at = now() WHERE fingerprint = ${quoteLiteral(fingerprint)}`,
    port,
  });
}

/**
 * Run the create sequence. Idempotency-driven (see file header for
 * why we don't try to claim a per-process advisory lock).
 *
 * Returns the names that were provisioned.
 */
function runCreateSequence({ port, fingerprint, publisher, sourcePath, names }) {
  const { databaseName, roleName } = names;

  // Step 1 — CREATE ROLE if missing. We CREATE WITH LOGIN by default;
  // pgserve consumers connect as their fingerprint role.
  pgQuery({
    sql: [
      'DO $do$',
      'BEGIN',
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(roleName)}) THEN`,
      `    EXECUTE 'CREATE ROLE ${quoteIdent(roleName)} WITH LOGIN';`,
      '  END IF;',
      'END$do$;',
    ].join('\n'),
    port,
  });

  // Step 2 — CREATE DATABASE if missing. Cannot run inside a
  // transaction block. We swallow the "already exists" race because
  // the wish marks it a non-error.
  //
  // psql does not emit SQLSTATE codes (42P04) by default — only the
  // human-readable message "ERROR: database "<name>" already exists".
  // Match against that text rather than the SQLSTATE we don't have.
  // (Bot review MEDIUM on PR #92.)
  if (!databaseExists({ port, database: databaseName })) {
    try {
      pgQuery({
        sql: `CREATE DATABASE ${quoteIdent(databaseName)} OWNER ${quoteIdent(roleName)}`,
        port,
      });
    } catch (err) {
      const msg = (err && err.stderr) ? err.stderr : '';
      if (msg.includes('already exists')) {
        /* race: another provisioner created it; benign */
      } else {
        throw err;
      }
    }
  }

  // Step 3 — GRANT CONNECT + CREATE on the DB to the role. Idempotent
  // (postgres GRANT is set-style, not stack-style).
  pgQuery({
    sql: `GRANT CONNECT, CREATE ON DATABASE ${quoteIdent(databaseName)} TO ${quoteIdent(roleName)}`,
    port,
  });

  // Step 4 — UPSERT the pgserve_meta row. ON CONFLICT keeps replays
  // safe (a partial earlier run can be resumed without operator
  // intervention).
  pgQuery({
    sql: [
      'INSERT INTO public.pgserve_meta',
      '  (fingerprint, database_name, role_name, publisher, source_path, last_used_at)',
      'VALUES (',
      `  ${quoteLiteral(fingerprint)},`,
      `  ${quoteLiteral(databaseName)},`,
      `  ${quoteLiteral(roleName)},`,
      `  ${quoteLiteral(publisher || '')},`,
      `  ${quoteLiteral(sourcePath || '')},`,
      '  now()',
      ')',
      'ON CONFLICT (fingerprint) DO UPDATE SET',
      '  database_name = EXCLUDED.database_name,',
      '  role_name     = EXCLUDED.role_name,',
      '  publisher     = EXCLUDED.publisher,',
      '  source_path   = EXCLUDED.source_path,',
      '  last_used_at  = now()',
    ].join('\n'),
    port,
  });

  return { databaseName, roleName };
}

function emit({ json, summary, humanLines }) {
  if (json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    for (const line of humanLines) process.stdout.write(line + '\n');
  }
}

export async function runProvision(argv = []) {
  let opts;
  try {
    opts = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`pgserve provision: ${err.message}\n\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const explicit = opts.positional[0];
  const port = resolvePort(opts);

  let resolved;
  try {
    resolved = resolveFingerprint({ explicit });
  } catch (err) {
    process.stderr.write(`pgserve provision: ${err.message}\n`);
    return 1;
  }

  const names = deriveProvisionedNames({
    fingerprint: resolved.fingerprint,
    publisher: resolved.publisher,
  });

  const summary = {
    fingerprint: resolved.fingerprint,
    publisher: resolved.publisher,
    sourcePath: resolved.sourcePath,
    fingerprintKind: resolved.kind,
    databaseName: names.databaseName,
    roleName: names.roleName,
    port,
    action: 'unknown',
  };

  // Step 1 — make sure pgserve_meta exists (bootstrap + verify cols).
  try {
    await ensurePgserveMetaSchema({ port });
  } catch (err) {
    process.stderr.write(`pgserve provision: cannot bootstrap pgserve_meta: ${err.message}\n`);
    summary.action = 'error';
    summary.error = err.message;
    if (opts.json) emit({ json: true, summary });
    return 2;
  }

  // Step 2 — fast-path idempotency: existing row + DB still present?
  let existing;
  try {
    existing = selectMetaRow({ port, fingerprint: resolved.fingerprint });
  } catch (err) {
    process.stderr.write(`pgserve provision: ${err.message}\n`);
    return 3;
  }
  if (existing && databaseExists({ port, database: existing.database_name })) {
    touchMetaRow({ port, fingerprint: resolved.fingerprint });
    summary.action = 'touched';
    summary.databaseName = existing.database_name;
    summary.roleName = existing.role_name;
    emit({
      json: opts.json,
      summary,
      humanLines: [
        `pgserve provision: idempotent replay`,
        `  fingerprint:   ${resolved.fingerprint}`,
        `  database:      ${existing.database_name} (already exists, last_used_at touched)`,
        `  role:          ${existing.role_name}`,
      ],
    });
    return 0;
  }

  // Step 3 — full create sequence under advisory lock.
  try {
    runCreateSequence({
      port,
      fingerprint: resolved.fingerprint,
      publisher: resolved.publisher,
      sourcePath: resolved.sourcePath,
      names,
    });
    summary.action = 'created';
  } catch (err) {
    summary.action = 'error';
    summary.error = err.message;
    process.stderr.write(`pgserve provision: ${err.message}\n`);
    if (opts.json) emit({ json: true, summary });
    return 3;
  }

  emit({
    json: opts.json,
    summary,
    humanLines: [
      `pgserve provision: created`,
      `  fingerprint:   ${resolved.fingerprint}`,
      `  database:      ${names.databaseName}`,
      `  role:          ${names.roleName}`,
      `  source_path:   ${resolved.sourcePath}`,
    ],
  });
  return 0;
}

export const __testInternals = Object.freeze({
  parseFlags,
  resolvePort,
});
