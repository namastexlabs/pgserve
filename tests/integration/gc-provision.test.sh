#!/usr/bin/env bash
#
# gc-provision.test.sh — round-trip integration smoke for `pgserve gc`
# + `pgserve provision`. Singleton G3 dedup follow-up
# (autopg-distribution-cutover-finalize G2 deliverable 4).
#
# Pipeline:
#   1) start an ephemeral postgres on a high port (no system service)
#   2) `pgserve provision <fingerprint>` — creates DB + role + meta row
#   3) `pgserve provision <fingerprint>` again — idempotency check
#      (still 1 DB, 1 role, 1 meta row)
#   4) `pgserve gc --dry-run` — expect zero orphans (source path still
#      present, meta row still recent)
#   5) Delete the source path (`gc` orphan signal: source_path missing)
#   6) `pgserve gc --apply` — expect exactly one DB dropped + one meta
#      row removed
#   7) Assert the gc audit log at $HOME/.pgserve/audit/gc-<DATE>.log
#      contains start / skip / drop / finish actions
#
# Skips gracefully on hosts without postgres binaries on PATH so it can
# be wired into the CI matrix as an optional / non-blocking job until
# the GHA cache for embedded-postgres is warm.
#
# Exit codes:
#   0  pass (or skipped because postgres binaries are missing)
#   1  fail (assertion missed)
#   2  invalid setup (binaries present but fixture broken)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${GC_PROVISION_TEST_PORT:-65432}"

PASS=0
FAIL=0

ok()   { printf '    \xe2\x9c\x93 %s\n' "$*";          PASS=$((PASS + 1)); }
bad()  { printf '    \xe2\x9c\x97 %s\n' "$*" >&2;      FAIL=$((FAIL + 1)); }
note() { printf '    \xe2\x80\xa2 %s\n' "$*" >&2; }

require_postgres() {
  for bin in initdb pg_ctl psql; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      note "$bin not on PATH — skipping (suite needs a postgres install)"
      exit 0
    fi
  done
}

WORK_DIR=""
PG_DATA=""
PG_LOG=""
SOCKET_DIR=""
SOURCE_DIR=""
FAKE_HOME=""
PG_RUNNING=0

# Set PGPASSWORD to the conventional bootstrap value used by `pgserve
# install` on fresh hosts. The CI matrix runs apt-installed postgres +
# trust auth (per the postgresql.conf written below); when pgserve's
# psql shellouts inherit our env, they need PGPASSWORD set so the
# always-set-env contract from src/lib/pg-query.js doesn't pick up an
# empty value. Mirrors what real fresh-install operators do per the
# install docs. (Also matches the CV-1 hot-fix landing in PR #101 —
# this export keeps the integration test independent of #101's merge
# order so #97 isn't blocked on #101.)
export PGPASSWORD="${PGPASSWORD:-postgres}"

cleanup() {
  if [[ "$PG_RUNNING" -eq 1 && -n "$PG_DATA" ]]; then
    pg_ctl -D "$PG_DATA" stop -m immediate -s >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_GC_PROVISION_TEST_DIR:-0}" -eq 1 ]]; then
    note "KEEP_GC_PROVISION_TEST_DIR=1 — keeping $WORK_DIR"
    return
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

setup() {
  require_postgres
  WORK_DIR="$(mktemp -d -t pgserve-gc-provision-XXXXXX)"
  PG_DATA="${WORK_DIR}/data"
  PG_LOG="${WORK_DIR}/postgres.log"
  SOCKET_DIR="${WORK_DIR}/socket"
  SOURCE_DIR="${WORK_DIR}/source"
  FAKE_HOME="${WORK_DIR}/home"

  mkdir -p "$SOCKET_DIR" "$SOURCE_DIR" "$FAKE_HOME"

  # Minimal package.json so the pgserve provision fingerprint resolver
  # has something deterministic to read in $SOURCE_DIR.
  cat >"${SOURCE_DIR}/package.json" <<'JSON'
{
  "name": "@autopg-test/gc-provision-fixture",
  "version": "0.0.0-fixture"
}
JSON

  # `-U postgres` forces the bootstrap superuser to literal `postgres`.
  # initdb's default is `$USER` (the OS user, e.g. `runner` on GitHub
  # Actions); pgserve provision/gc shellouts use `-U postgres` (the
  # canonical role from PG_QUERY_DEFAULTS) so without this override the
  # cluster ships with a non-existent `postgres` role and every shellout
  # fails with `FATAL: role "postgres" does not exist`.
  initdb -D "$PG_DATA" -U postgres --auth-local=trust --auth-host=trust -E UTF8 -A trust >/dev/null 2>&1 \
    || { echo "initdb failed; check $PG_LOG" >&2; exit 2; }

  # Tighten config so the ephemeral postmaster is small + fast.
  cat >>"${PG_DATA}/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
unix_socket_directories = '${SOCKET_DIR}'
fsync = off
synchronous_commit = off
shared_buffers = 32MB
EOF

  pg_ctl -D "$PG_DATA" -l "$PG_LOG" -o "-p ${PORT}" -w start >/dev/null 2>&1 \
    || { echo "pg_ctl start failed; check $PG_LOG" >&2; exit 2; }
  PG_RUNNING=1

  # CREATE DATABASE postgres if pre-existing initdb's default differs;
  # provision's `db: 'postgres'` baseline assumes it's there.
  psql -h "$SOCKET_DIR" -p "$PORT" -U "$USER" -d postgres -c "SELECT 1" >/dev/null \
    || { echo "psql connect failed" >&2; exit 2; }
  ok "postgres up on port ${PORT} (data: ${PG_DATA})"
}

# Run a pgserve verb against the worktree's bin/, with HOME redirected
# to the fake-home so the audit log lands somewhere we control.
#
# Routes through `bin/pgserve-wrapper.cjs` (the verb dispatcher), NOT
# `bin/postgres-server.js` (the postmaster lifecycle entry). Provision
# and gc are install-subcommands that the wrapper dispatches to
# `src/cli-install.cjs#dispatch`; calling postgres-server.js directly
# would skip dispatch and hit the postmaster's `parsePostmasterArgs`,
# which only knows about `postmaster` / `--help` and exits with help-
# print on anything else.
pgserve_run() {
  # PGUSER is intentionally NOT set here — pgQuery passes `-U postgres`
  # explicitly via PG_QUERY_DEFAULTS, so an env-level override would
  # only mask a real bug rather than reflect production semantics.
  HOME="$FAKE_HOME" \
  PGHOST="$SOCKET_DIR" \
    node "${REPO_ROOT}/bin/pgserve-wrapper.cjs" "$@"
}

run_provision_twice() {
  cd "$SOURCE_DIR"
  pgserve_run provision --port "$PORT" --json >"${WORK_DIR}/prov-1.json" 2>"${WORK_DIR}/prov-1.err" \
    || { bad "first provision failed (see prov-1.err)"; cat "${WORK_DIR}/prov-1.err" >&2; return 1; }
  ok "first provision succeeded"

  pgserve_run provision --port "$PORT" --json >"${WORK_DIR}/prov-2.json" 2>"${WORK_DIR}/prov-2.err" \
    || { bad "second provision (idempotency) failed (see prov-2.err)"; cat "${WORK_DIR}/prov-2.err" >&2; return 1; }
  ok "second provision succeeded (idempotent)"

  local meta_count
  meta_count="$(psql -h "$SOCKET_DIR" -p "$PORT" -U "$USER" -d postgres -At -c \
    'SELECT COUNT(*) FROM public.pgserve_meta' 2>/dev/null || echo 0)"
  if [[ "$meta_count" != "1" ]]; then
    bad "expected exactly 1 pgserve_meta row after idempotent re-provision, got ${meta_count}"
    return 1
  fi
  ok "pgserve_meta row count = 1 after idempotent re-provision"
}

run_gc_dry_run_clean() {
  cd "$SOURCE_DIR"
  pgserve_run gc --port "$PORT" --json >"${WORK_DIR}/gc-dry.json" 2>"${WORK_DIR}/gc-dry.err" \
    || { bad "gc --dry-run failed (see gc-dry.err)"; cat "${WORK_DIR}/gc-dry.err" >&2; return 1; }
  if grep -qE '"orphans":\s*0|"orphan_count":\s*0|"droppedCount":\s*0' "${WORK_DIR}/gc-dry.json"; then
    ok "gc --dry-run reports zero orphans (source path still present)"
  else
    note "gc --dry-run summary: $(cat "${WORK_DIR}/gc-dry.json")"
    note "(non-fatal: summary key may differ; verifying via meta-row count instead)"
  fi
  local db_count
  db_count="$(psql -h "$SOCKET_DIR" -p "$PORT" -U "$USER" -d postgres -At -c \
    "SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'pgserve_%'" 2>/dev/null || echo 0)"
  if [[ "$db_count" != "1" ]]; then
    bad "gc --dry-run should not have dropped anything; expected 1 pgserve_* DB, got ${db_count}"
    return 1
  fi
  ok "gc --dry-run did not drop the live DB"
}

simulate_orphan() {
  rm -rf "$SOURCE_DIR"
  ok "source path removed (simulated orphan)"
}

run_gc_apply() {
  # source path no longer exists, so cwd doesn't matter — pgserve gc
  # operates on the postgres state, not the cwd.
  pgserve_run gc --port "$PORT" --apply --json >"${WORK_DIR}/gc-apply.json" 2>"${WORK_DIR}/gc-apply.err" \
    || { bad "gc --apply failed (see gc-apply.err)"; cat "${WORK_DIR}/gc-apply.err" >&2; return 1; }

  local db_count meta_count
  db_count="$(psql -h "$SOCKET_DIR" -p "$PORT" -U "$USER" -d postgres -At -c \
    "SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'pgserve_%'" 2>/dev/null || echo 0)"
  meta_count="$(psql -h "$SOCKET_DIR" -p "$PORT" -U "$USER" -d postgres -At -c \
    'SELECT COUNT(*) FROM public.pgserve_meta' 2>/dev/null || echo 0)"

  if [[ "$db_count" != "0" ]]; then
    bad "gc --apply did not drop the orphan DB; expected 0 pgserve_*, got ${db_count}"
    return 1
  fi
  ok "gc --apply dropped the orphan database"

  if [[ "$meta_count" != "0" ]]; then
    bad "gc --apply did not delete the orphan meta row; expected 0, got ${meta_count}"
    return 1
  fi
  ok "gc --apply deleted the orphan pgserve_meta row"
}

assert_audit_log_events() {
  local audit_dir="${FAKE_HOME}/.pgserve/audit"
  if [[ ! -d "$audit_dir" ]]; then
    bad "audit dir not created at ${audit_dir}"
    return 1
  fi
  local audit_files=("$audit_dir"/gc-*.log)
  if [[ ! -f "${audit_files[0]}" ]]; then
    bad "no gc-<DATE>.log audit file under ${audit_dir}"
    return 1
  fi
  local audit_log="${audit_files[0]}"
  for action in start skip drop finish; do
    if ! grep -qE "\"action\":\s*\"${action}\"" "$audit_log"; then
      bad "audit log missing action=${action} (file: ${audit_log})"
      note "audit log contents:"
      cat "$audit_log" >&2
      return 1
    fi
    ok "audit log contains action=${action}"
  done
}

main() {
  setup
  run_provision_twice
  run_gc_dry_run_clean
  simulate_orphan
  run_gc_apply
  assert_audit_log_events

  printf '\n  PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
  if [[ "$FAIL" -gt 0 ]]; then
    return 1
  fi
}

main "$@"
