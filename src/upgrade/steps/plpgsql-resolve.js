/**
 * Step 3 — plpgsql extension re-resolve.
 * DROP+CREATE plpgsql per user DB to refresh `.so` path against current $libdir.
 * Skips DBs with user-owned plpgsql functions (CASCADE would drop them).
 */

import { execSync } from 'node:child_process';

export const name = 'plpgsql-resolve';
const CANONICAL_PORT = 8432;
const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);

function pgQuery({ db, sql, captureStdout = false }) {
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' };
  const cmd = `psql -h 127.0.0.1 -p ${CANONICAL_PORT} -U postgres -d ${db} -At -c ${JSON.stringify(sql)}`;
  return captureStdout
    ? execSync(cmd, { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
    : execSync(cmd, { env, stdio: 'pipe' });
}

function listUserDbs() {
  const out = pgQuery({
    db: 'postgres',
    sql: "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname != 'postgres' ORDER BY datname",
    captureStdout: true,
  });
  return out ? out.split('\n').filter(Boolean) : [];
}

function hasUserOwnedPlpgsqlFunctions(db) {
  const out = pgQuery({
    db,
    sql: "SELECT count(*) FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid WHERE l.lanname = 'plpgsql' AND p.proowner != 10",
    captureStdout: true,
  });
  return parseInt(out, 10) > 0;
}

export async function plan() {
  let dbs;
  try { dbs = listUserDbs(); } catch (err) { return `cannot enumerate DBs: ${err.message}`; }
  return `would DROP+CREATE plpgsql in ${dbs.length} user DB(s): ${dbs.join(', ')}`;
}

export async function execute({ warn }) {
  let dbs;
  try { dbs = listUserDbs(); } catch (err) { return { status: 'FAIL', detail: `cannot enumerate DBs: ${err.message}` }; }
  if (dbs.length === 0) return { status: 'SKIP', detail: 'no user DBs to refresh' };

  let refreshed = 0, skipped = 0;
  for (const db of dbs) {
    if (SYSTEM_DBS.has(db)) { skipped++; continue; }
    try {
      if (hasUserOwnedPlpgsqlFunctions(db)) {
        warn(`[plpgsql-resolve] skip ${db}: user-owned plpgsql functions present (DROP CASCADE would lose them)`);
        skipped++; continue;
      }
      pgQuery({ db, sql: 'DROP EXTENSION IF EXISTS plpgsql CASCADE; CREATE EXTENSION plpgsql' });
      refreshed++;
    } catch (err) {
      warn(`[plpgsql-resolve] ${db} failed: ${err.message}`);
      skipped++;
    }
  }
  return { status: 'OK', detail: `refreshed ${refreshed} DB(s), skipped ${skipped}` };
}
