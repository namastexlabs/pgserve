/**
 * Step 6 — Health validation.
 *
 * Final check: pg_isready on canonical port + per-DB plpgsql smoke test
 * (DO block runs without "could not access file" error).
 *
 * Returns FAIL if any check breaks. Caller (orchestrator) surfaces this
 * to operator.
 */

const { execSync } = require('node:child_process');

const CANONICAL_PORT = 8432;
const SYSTEM_DBS = new Set(['template0', 'template1']);

function pgIsReady() {
  try {
    execSync(`pg_isready -h 127.0.0.1 -p ${CANONICAL_PORT}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function listAllDbs() {
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' };
  const out = execSync(
    `psql -h 127.0.0.1 -p ${CANONICAL_PORT} -U postgres -At -c "SELECT datname FROM pg_database WHERE NOT datistemplate"`,
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString().trim();
  return out ? out.split('\n').filter(Boolean) : [];
}

function plpgsqlSmoke(db) {
  try {
    const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'postgres' };
    execSync(
      `psql -h 127.0.0.1 -p ${CANONICAL_PORT} -U postgres -d ${db} -At -c "DO \\$\\$ BEGIN RAISE NOTICE 'ok'; END; \\$\\$"`,
      { env, stdio: 'pipe' },
    );
    return true;
  } catch {
    return false;
  }
}

async function plan() {
  return `would check pg_isready on :${CANONICAL_PORT} + plpgsql smoke test in each user DB`;
}

async function execute({ warn }) {
  if (!pgIsReady()) {
    return { status: 'FAIL', detail: `pg_isready failed on port ${CANONICAL_PORT}` };
  }
  let dbs;
  try { dbs = listAllDbs(); } catch (err) { return { status: 'FAIL', detail: `cannot list DBs: ${err.message}` }; }

  let pass = 0, fail = 0;
  for (const db of dbs) {
    if (SYSTEM_DBS.has(db)) continue;
    if (plpgsqlSmoke(db)) pass++;
    else { fail++; warn(`[health-validate] plpgsql smoke FAIL in ${db}`); }
  }
  if (fail > 0) return { status: 'FAIL', detail: `${pass}/${pass + fail} DBs healthy; ${fail} plpgsql smoke failure(s)` };
  return { status: 'OK', detail: `pg_isready OK, plpgsql healthy in ${pass}/${pass} DBs` };
}

module.exports = { name: 'health-validate', plan, execute };
