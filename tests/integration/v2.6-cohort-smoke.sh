#!/usr/bin/env bash
#
# v2.6-cohort-smoke.sh — end-to-end smoke for the v2.6 cohort.
# autopg-distribution-cutover-finalize wish, Group 5 deliverable 2.
#
# Exercises the full surface of v2.6 against a fresh $HOME using the
# LOCAL build (the changes about to be released), NOT the published
# version. Per wish text: "Do NOT use `npx pgserve@latest` — that would
# test the published version, not the changes about to be released."
#
# Pipeline:
#   1) ephemeral $HOME, ephemeral postgres on a high port
#   2) `pgserve provision @demo/app` — creates DB + role + meta row
#   3) workload — write a row, read it back
#   4) `pgserve gc --dry-run` — zero orphans expected
#   5) `pgserve doctor --json` — zero FAIL findings expected
#   6) `pgserve trust list` — three hardcoded entries expected
#   7) `pgserve create-app demo` — registers in autopg_meta + writes
#      ~/.autopg/demo/{admin,manifest}.json
#   8) Assert the audit log captured each step
#   9) Cleanup (rm -rf $HOME)
#
# Skips gracefully on hosts without postgres binaries on PATH so it can
# be wired into the CI matrix as an optional / non-blocking job until
# the GHA cache for embedded-postgres is warm. Same posture as the
# sibling `gc-provision.test.sh`.
#
# Exit codes:
#   0  pass (or skipped because postgres binaries are missing)
#   1  any acceptance criterion failed
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=${PORT:-15432}
SLUG="@demo/app"
APP_NAME="demo"

# ---------- Skip gracefully if postgres binaries are missing ----------
if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
    echo "v2.6-cohort-smoke: SKIP (initdb/pg_ctl not on PATH)"
    exit 0
fi

# ---------- Ephemeral $HOME + ephemeral postgres ----------
TMP_HOME=$(mktemp -d -t pgserve-v26-smoke-XXXXXX)
PG_DATA="$TMP_HOME/pgdata"
LOG_FILE="$TMP_HOME/postgres.log"
SOURCE_PATH=$(mktemp -d -t pgserve-v26-smoke-app-XXXXXX)
echo "v2.6-cohort-smoke: HOME=$TMP_HOME PGDATA=$PG_DATA SOURCE=$SOURCE_PATH"

cleanup() {
    set +e
    pg_ctl -D "$PG_DATA" -m fast stop >/dev/null 2>&1
    rm -rf "$TMP_HOME" "$SOURCE_PATH"
}
trap cleanup EXIT

initdb -D "$PG_DATA" -U postgres -A trust >/dev/null
sed -i.bak \
    -e "s/^#port = 5432/port = $PORT/" \
    -e "s/^#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" \
    "$PG_DATA/postgresql.conf"
pg_ctl -D "$PG_DATA" -l "$LOG_FILE" -o "-p $PORT" start >/dev/null

# ---------- Run pgserve commands against the ephemeral cluster ----------
export HOME="$TMP_HOME"
export AUTOPG_SKIP_POSTINSTALL=1
export PGPASSWORD="${PGPASSWORD:-postgres}"

PGSERVE="$REPO_ROOT/bin/pgserve-wrapper.cjs"
[ -x "$PGSERVE" ] || PGSERVE="node $REPO_ROOT/bin/pgserve-wrapper.cjs"

step() {
    echo
    echo "==> $1"
}

# Used by provision/gc/create-app/etc. to find the cluster
export PGSERVE_PORT="$PORT"

# Create a fake package.json to anchor the fingerprint
cat >"$SOURCE_PATH/package.json" <<EOF
{ "name": "$SLUG", "version": "0.0.0" }
EOF

step "Step 2/8 — pgserve provision $SLUG"
node "$REPO_ROOT/bin/pgserve-wrapper.cjs" provision "$SLUG" --source "$SOURCE_PATH" --port "$PORT" \
    || { echo "FAIL: provision exited non-zero"; exit 1; }

step "Step 3/8 — workload (write + read)"
# pgserve provision --json emits camelCase `databaseName`; second invocation
# is idempotent (already-provisioned in step 2 above) so we just read the name.
DB_NAME="$(node "$REPO_ROOT/bin/pgserve-wrapper.cjs" provision "$SLUG" --source "$SOURCE_PATH" --port "$PORT" --json 2>/dev/null \
    | grep -oE '"databaseName":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
if [ -z "$DB_NAME" ]; then
    echo "FAIL: could not parse databaseName from pgserve provision --json output"
    exit 1
fi
psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB_NAME" \
    -c "CREATE TABLE IF NOT EXISTS smoke (k text PRIMARY KEY, v int)" >/dev/null
psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB_NAME" \
    -c "INSERT INTO smoke VALUES ('hello', 42) ON CONFLICT DO NOTHING" >/dev/null
ROW=$(psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB_NAME" -tAc "SELECT v FROM smoke WHERE k='hello'")
[ "$ROW" = "42" ] || { echo "FAIL: workload row mismatch (got '$ROW')"; exit 1; }

step "Step 4/8 — pgserve gc --dry-run (zero orphans expected)"
GC_OUT=$(node "$REPO_ROOT/bin/pgserve-wrapper.cjs" gc --dry-run --port "$PORT" --json 2>/dev/null) \
    || { echo "FAIL: gc --dry-run exited non-zero"; exit 1; }
echo "$GC_OUT" | grep -qE '"orphans":\s*0' \
    || { echo "FAIL: expected zero orphans, got: $GC_OUT"; exit 1; }

step "Step 5/8 — pgserve doctor --json (zero FAIL expected)"
DOCTOR_OUT=$(node "$REPO_ROOT/bin/pgserve-wrapper.cjs" doctor --json 2>/dev/null) \
    || { echo "FAIL: doctor exited non-zero"; exit 1; }
FAIL_COUNT=$(echo "$DOCTOR_OUT" | grep -oE '"status":"FAIL"' | wc -l | tr -d ' ')
[ "$FAIL_COUNT" = "0" ] \
    || { echo "FAIL: doctor reports $FAIL_COUNT FAIL findings"; echo "$DOCTOR_OUT"; exit 1; }

step "Step 6/8 — pgserve trust list (three hardcoded entries expected)"
TRUST_OUT=$(node "$REPO_ROOT/bin/pgserve-wrapper.cjs" trust list --json 2>/dev/null) \
    || { echo "FAIL: trust list exited non-zero"; exit 1; }
HARDCODED_COUNT=$(echo "$TRUST_OUT" | grep -oE '"source":"hardcoded"' | wc -l | tr -d ' ')
[ "$HARDCODED_COUNT" -ge "3" ] \
    || { echo "FAIL: expected >= 3 hardcoded trust entries, got $HARDCODED_COUNT"; exit 1; }

step "Step 7/8 — pgserve create-app $APP_NAME (registers in autopg_meta)"
node "$REPO_ROOT/bin/pgserve-wrapper.cjs" create-app "$APP_NAME" --port "$PORT" \
    || { echo "FAIL: create-app exited non-zero"; exit 1; }
[ -f "$HOME/.autopg/$APP_NAME/admin.json" ] \
    || { echo "FAIL: ~/.autopg/$APP_NAME/admin.json missing"; exit 1; }
[ -f "$HOME/.autopg/$APP_NAME/manifest.json" ] \
    || { echo "FAIL: ~/.autopg/$APP_NAME/manifest.json missing"; exit 1; }
# Verify mode 0600 on manifest, 0700 on dir.
# GNU stat (Linux): -c '%a' for octal perms.
# BSD stat (macOS):  -f '%Lp' for octal perms — '%A' returns SymbolicMode, not octal.
DIR_MODE=$(stat -c '%a' "$HOME/.autopg/$APP_NAME" 2>/dev/null || stat -f '%Lp' "$HOME/.autopg/$APP_NAME")
FILE_MODE=$(stat -c '%a' "$HOME/.autopg/$APP_NAME/manifest.json" 2>/dev/null || stat -f '%Lp' "$HOME/.autopg/$APP_NAME/manifest.json")
[ "$DIR_MODE" = "700" ] || { echo "FAIL: dir mode is $DIR_MODE not 700"; exit 1; }
[ "$FILE_MODE" = "600" ] || { echo "FAIL: manifest mode is $FILE_MODE not 600"; exit 1; }

step "Step 8/8 — Assert audit log captured the run"
AUDIT_FILE="$HOME/.pgserve/audit/gc-$(date -u +%Y-%m-%d).log"
[ -f "$AUDIT_FILE" ] || { echo "FAIL: audit log $AUDIT_FILE missing"; exit 1; }
grep -q '"action":"start"' "$AUDIT_FILE" || { echo "FAIL: no 'start' event in audit log"; exit 1; }
grep -q '"action":"finish"' "$AUDIT_FILE" || { echo "FAIL: no 'finish' event in audit log"; exit 1; }

echo
echo "v2.6-cohort-smoke: PASS"
echo "  - provision idempotent ✓"
echo "  - workload write+read ✓"
echo "  - gc dry-run zero orphans ✓"
echo "  - doctor zero FAIL ✓"
echo "  - trust hardcoded entries ≥3 ✓"
echo "  - create-app manifest mode 0600 / dir 0700 ✓"
echo "  - audit log captured run ✓"
exit 0
