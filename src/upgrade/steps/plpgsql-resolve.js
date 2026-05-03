/**
 * Step 3 — plpgsql extension re-resolve.
 *
 * For each user DB, DROP+CREATE plpgsql to force PG to re-lookup the
 * .so file path against the current $libdir. This fixes the "could not
 * access file 'plpgsql'" error that surfaces after autopg moves the
 * binary cache (commit 0075c4f) — pg_extension metadata pins absolute
 * paths and only DROP/CREATE refreshes them.
 *
 * Safety: skips template/system DBs and any DB containing user-owned
 * plpgsql functions (gate on pg_proc.proowner != 10). Skipping one DB
 * does not abort the whole step.
 *
 * Idempotent: extension is always present after CREATE.
 */

const { execSync } = require('node:child_process');

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
  const sql = "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname != 'postgres' ORDER BY datname";
  const out = pgQuery({ db: 'postgres', sql, captureStdout: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

function hasUserOwnedPlpgsqlFunctions(db) {
  const sql = "SELECT count(*) FROM pg_proc p JOIN pg_language l ON p.prolang = l.oid WHERE l.lanname = 'plpgsql' AND p.proowner != 10";
  const out = pgQuery({ db, sql, captureStdout: true });
  return parseInt(out, 10) > 0;
}

async function plan() {
  let dbs;
  try { dbs = listUserDbs(); } catch (err) { return `cannot enumerate DBs: ${err.message}`; }
  return `would DROP+CREATE plpgsql in ${dbs.length} user DB(s): ${dbs.join(', ')} (skipping any with user-owned plpgsql functions)`;
}

async function execute({ log, warn }) {
  let dbs;
  try { dbs = listUserDbs(); } catch (err) { return { status: 'FAIL', detail: `cannot enumerate DBs: ${err.message}` }; }
  if (dbs.length === 0) return { status: 'SKIP', detail: 'no user DBs to refresh' };

  let refreshed = 0;
  let skipped = 0;
  for (const db of dbs) {
    if (SYSTEM_DBS.has(db)) { skipped++; continue; }
    try {
      if (hasUserOwnedPlpgsqlFunctions(db)) {
        warn(`[plpgsql-resolve] skip ${db}: has user-owned plpgsql functions (DROP CASCADE would lose them)`);
        skipped++;
        continue;
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

module.exports = { name: 'plpgsql-resolve', plan, execute };
