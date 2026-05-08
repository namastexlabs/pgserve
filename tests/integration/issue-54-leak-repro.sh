#!/usr/bin/env bash
#
# issue-54-leak-repro.sh — Group 4 of autopg-distribution-cutover.
#
# Reproduces the connection-leak class that issue #54 originally surfaced
# under the deleted bun-proxy stack: high-frequency connect/disconnect
# churn caused router workers to forget cleanup, and pg_stat_activity
# would steadily grow until the postgres backend hit max_connections and
# refused new sessions.
#
# This fixture exists to PROVE the class is gone in the post-G4 layout
# (no router, no proxy, embedded postgres reached directly). It drives
# a 60-second 60+ conn/s loop against an isolated embedded postgres
# bound to 127.0.0.1:65432 with its data dir in $TMP, then asserts
# pg_stat_activity backend count returns to baseline after the loop.
#
# Acceptance assertions (wish §G4):
#   L1. Embedded postgres comes online on 127.0.0.1:65432 inside 30s.
#   L2. Loop completes ≥ 3,600 connect+SELECT 1+disconnect cycles
#       (60 conn/s × 60 s) without any auth/connection error.
#   L3. After the loop drains for 2 s, pg_stat_activity backend count
#       returns to its pre-loop baseline (zero leaked backends).
#   L4. The script tears down its data dir and config dir cleanly.
#
# Wish-validation contract:
#   bash tests/integration/issue-54-leak-repro.sh
#
# Exit codes:
#   0  pass
#   1  leaked backends or assertion missed
#   2  setup / prerequisite missing (bun, postgres binary, port busy)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

PORT="${AUTOPG_LEAK_PORT:-65432}"
DURATION="${AUTOPG_LEAK_DURATION:-60}"
RATE="${AUTOPG_LEAK_RATE:-60}"

command -v bun >/dev/null 2>&1 || { echo "error: bun not on PATH" >&2; exit 2; }

# Refuse to run if something is already on $PORT — the test would hijack
# whatever else is listening and produce nonsense baselines.
if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "error: 127.0.0.1:$PORT is already in use; set AUTOPG_LEAK_PORT to an unused port" >&2
  exit 2
fi

WORK_ROOT="$(mktemp -d -t autopg-leak-repro-XXXXXX)"
KEEP_WORK="${AUTOPG_KEEP_WORK:-0}"

cleanup() {
  if [[ "$KEEP_WORK" -eq 1 ]]; then
    echo "AUTOPG_KEEP_WORK=1 — keeping ${WORK_ROOT}"
    return
  fi
  [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]] && rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

PGDATA="${WORK_ROOT}/pgdata"
CONFIG_DIR="${WORK_ROOT}/config"
mkdir -p "$PGDATA" "$CONFIG_DIR"

echo "issue-54 leak repro:"
echo "  port:      $PORT"
echo "  duration:  ${DURATION}s"
echo "  target:    ${RATE} conn/s"
echo "  data:      $PGDATA"
echo "  config:    $CONFIG_DIR"

# The whole connect/disconnect loop runs inside one bun process so we can
# drive PostgresManager + bun:sql directly. Shelling out to psql per
# iteration would be dominated by spawn cost and never reach 60 conn/s on
# a CI host.
AUTOPG_CONFIG_DIR="$CONFIG_DIR" \
PGSERVE_DATA_DIR="$PGDATA" \
PGSERVE_PORT="$PORT" \
PGSERVE_DURATION="$DURATION" \
PGSERVE_RATE="$RATE" \
PGSERVE_REPO_ROOT="$REPO_ROOT" \
bun --silent -e '
const fs = await import("fs");
const path = await import("path");
const { SQL } = await import("bun");
const { PostgresManager } = await import(path.join(process.env.PGSERVE_REPO_ROOT, "src/postgres.js"));
const { ADMIN_ROLE } = await import(path.join(process.env.PGSERVE_REPO_ROOT, "src/auth/admin-bootstrap.js"));

const port = parseInt(process.env.PGSERVE_PORT, 10);
const dataDir = process.env.PGSERVE_DATA_DIR;
const configDir = process.env.AUTOPG_CONFIG_DIR;
const durationS = parseInt(process.env.PGSERVE_DURATION, 10);
const ratePerS = parseInt(process.env.PGSERVE_RATE, 10);

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {},
  child: () => silentLogger,
};

console.log("    > spawning embedded postgres...");
const pg = new PostgresManager({ dataDir, port, host: "127.0.0.1", logger: silentLogger });
const startedAt = Date.now();

let exit = 0;
try {
  await pg.start();
  console.log(`    ✓ L1: postgres online on 127.0.0.1:${port} (${Date.now() - startedAt} ms)`);

  const secretPath = path.join(configDir, "admin.secret");
  const password = fs.readFileSync(secretPath, "utf8").replace(/\r?\n$/, "");

  const baselineRows = await pg.adminPool`
    SELECT count(*)::int AS n
    FROM pg_stat_activity
    WHERE backend_type = ${"client backend"} AND pid <> pg_backend_pid()
  `;
  const baseline = baselineRows[0].n;
  console.log(`    > baseline pg_stat_activity client backends: ${baseline}`);

  console.log(`    > running ${durationS}s connect/disconnect loop at ~${ratePerS} conn/s...`);
  const targetCycles = durationS * ratePerS;
  const deadline = Date.now() + durationS * 1000;
  let cycles = 0;
  let firstFailure = null;

  while (Date.now() < deadline && cycles < targetCycles * 2) {
    const cycleClient = new SQL({
      hostname: "127.0.0.1",
      port,
      database: "postgres",
      username: ADMIN_ROLE,
      password,
      max: 1,
      idleTimeout: 1,
      connectionTimeout: 5,
    });
    try {
      const r = await cycleClient`SELECT 1::int AS one`;
      if (r[0].one !== 1) throw new Error(`unexpected SELECT 1 result: ${JSON.stringify(r[0])}`);
      cycles += 1;
    } catch (err) {
      if (firstFailure === null) firstFailure = String(err && err.message || err);
    } finally {
      try { await cycleClient.close(); } catch { /* swallow */ }
    }
  }

  if (firstFailure) {
    console.error(`    ✗ L2: connection failure after ${cycles} cycles: ${firstFailure}`);
    exit = 1;
  } else if (cycles < targetCycles) {
    console.error(`    ✗ L2: only ${cycles}/${targetCycles} cycles completed in ${durationS}s (rate too low — host saturated?)`);
    exit = 1;
  } else {
    console.log(`    ✓ L2: ${cycles} successful connect/SELECT/disconnect cycles in ${durationS}s`);
  }

  // Drain: postgres backends close async after the client side closes.
  // 2s is comfortably longer than the 1s idleTimeout we set above.
  await new Promise((r) => setTimeout(r, 2000));

  const afterRows = await pg.adminPool`
    SELECT count(*)::int AS n
    FROM pg_stat_activity
    WHERE backend_type = ${"client backend"} AND pid <> pg_backend_pid()
  `;
  const after = afterRows[0].n;
  const leaked = after - baseline;

  if (leaked > 0) {
    console.error(`    ✗ L3: leaked ${leaked} backend(s) — baseline=${baseline}, after=${after}`);
    const orphans = await pg.adminPool`
      SELECT pid, application_name, client_addr::text AS client_addr, state, backend_start::text AS backend_start
      FROM pg_stat_activity
      WHERE backend_type = ${"client backend"} AND pid <> pg_backend_pid()
      ORDER BY backend_start
    `;
    console.error(`    diagnostic: ${JSON.stringify(orphans)}`);
    exit = 1;
  } else {
    console.log(`    ✓ L3: zero leaked backends (baseline=${baseline}, after=${after})`);
  }
} catch (err) {
  console.error(`    ✗ fixture error: ${err && err.stack || err}`);
  exit = 1;
} finally {
  try { await pg.stop(); } catch { /* swallow */ }
}

process.exit(exit);
'

EXIT=$?

if [[ $EXIT -eq 0 ]]; then
  echo "issue-54 leak repro: PASS"
else
  echo "issue-54 leak repro: FAIL (exit $EXIT)"
fi

exit $EXIT
