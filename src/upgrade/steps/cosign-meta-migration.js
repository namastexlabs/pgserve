/**
 * Step — pgserve_meta cosign columns (additive).
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Adds `verified_at`, `verified_identity`, `verified_tier` to every
 * `pgserve_meta` table the upgrade step finds. The schema delta is
 * additive (Decision P4) — pre-cosign rows continue to work, columns are
 * NULL until Group 3's `pgserve provision` writes them.
 *
 * Runs idempotently: `ADD COLUMN IF NOT EXISTS` plus a guarded DO-block
 * for the CHECK constraint. Re-running on an already-migrated host is a
 * no-op. If `pgserve_meta` does not exist (fresh install before G3 has
 * provisioned anything) the step is a SKIP.
 */

import { execSync } from 'node:child_process';

import { getMigrationStatements } from '../../cosign/schema.js';

export const name = 'cosign-meta-migration';
const CANONICAL_PORT = 5432;
const SYSTEM_DBS = new Set(['template0', 'template1']);

function pgQuery({ db, sql, captureStdout = false, port = CANONICAL_PORT }) {
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' };
  const cmd = `psql -h 127.0.0.1 -p ${port} -U postgres -d ${db} -At -c ${JSON.stringify(sql)}`;
  return captureStdout
    ? execSync(cmd, { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    : execSync(cmd, { env, stdio: 'pipe' });
}

function listUserDbs() {
  const out = pgQuery({
    db: 'postgres',
    sql: "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
    captureStdout: true,
  });
  return out ? out.split('\n').filter(Boolean).filter((d) => !SYSTEM_DBS.has(d)) : [];
}

function pgserveMetaExists(db) {
  const out = pgQuery({
    db,
    sql: "SELECT to_regclass('public.pgserve_meta') IS NOT NULL",
    captureStdout: true,
  });
  return out === 't' || out === 'true';
}

export async function plan() {
  let dbs;
  try {
    dbs = listUserDbs();
  } catch (err) {
    return `cannot enumerate DBs: ${err.message}`;
  }
  if (dbs.length === 0) return 'no user DBs — skip';
  const targets = [];
  for (const db of dbs) {
    try {
      if (pgserveMetaExists(db)) targets.push(db);
    } catch {
      // Skip silently — DB might be unreachable, listed but not connectable.
    }
  }
  if (targets.length === 0) return 'no DB hosts pgserve_meta yet — skip';
  return `would apply additive cosign columns to pgserve_meta in: ${targets.join(', ')}`;
}

export async function execute({ log, warn }) {
  let dbs;
  try {
    dbs = listUserDbs();
  } catch (err) {
    return { status: 'FAIL', detail: `cannot enumerate DBs: ${err.message}` };
  }
  if (dbs.length === 0) return { status: 'SKIP', detail: 'no user DBs to migrate' };

  const statements = getMigrationStatements();
  let migrated = 0;
  let skipped = 0;
  for (const db of dbs) {
    let exists;
    try {
      exists = pgserveMetaExists(db);
    } catch (err) {
      warn(`[cosign-meta-migration] ${db}: cannot probe pgserve_meta — ${err.message}`);
      skipped++;
      continue;
    }
    if (!exists) {
      skipped++;
      continue;
    }
    try {
      for (const sql of statements) {
        pgQuery({ db, sql });
      }
      log(`[cosign-meta-migration] ${db}: applied ${statements.length} idempotent statement(s)`);
      migrated++;
    } catch (err) {
      warn(`[cosign-meta-migration] ${db}: failed — ${err.message}`);
      skipped++;
    }
  }
  return { status: 'OK', detail: `migrated ${migrated} DB(s), skipped ${skipped}` };
}
