#!/usr/bin/env bash
#
# verify-slug-rotation.test.sh — round-trip integration smoke for
# `pgserve create-app` + `pgserve verify --slug` (G3 D5,
# autopg-distribution-cutover-finalize).
#
# Exercises the lock-vs-live trust differential that is the WHOLE point
# of the manifest LOCK 1 design:
#
#   1) start an ephemeral postgres on a high port
#   2) `pgserve create-app demo --port $PORT` — registers slug; freezes
#      whatever TRUSTED_IDENTITIES is live at this moment into
#      autopg_meta.locked_roots
#   3) Direct UPDATE to autopg_meta.locked_roots — replaces the freshly
#      frozen list with a SYNTHETIC identity ("FROZEN-LOCK"). This is
#      our test's stand-in for "operator-driven trust rotation has
#      since happened to live TRUSTED_IDENTITIES, and the slug's lock
#      is now divergent from live". The frozen lock is what verify
#      --slug should consult.
#   4) Stub cosign on PATH succeeds ONLY when the identity-regex passed
#      is `^FROZEN-LOCK$` AND the binary's first bytes are `FROZEN-LOCK`.
#      Anything else: exit non-zero. This makes the test discriminate
#      between "verify consulted the lock" and "verify consulted live
#      TRUSTED_IDENTITIES" by the cosign call's identity-regex argv.
#   5) Run THREE verify scenarios:
#        a) FROZEN-LOCK binary + --slug demo  → exit 0 (lock matched)
#        b) LIVE-IDENTITY binary + --slug demo → exit 2 (lock rejects)
#        c) any binary + --slug nonexistent_slug → exit 3 (invocation —
#           slug not registered; never reaches cosign)
#   6) Assert autopg_meta has exactly 1 row for the slug + that
#      idempotent re-run preserved locked_roots ("FROZEN-LOCK" stays;
#      live TRUSTED_IDENTITIES does NOT clobber the frozen lock).
#
# Together those five steps cover BRIEF v5 acceptance criterion #5
# (upgrade-after-trust-rotation against the frozen lock).
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
PORT="${VERIFY_SLUG_TEST_PORT:-65433}"

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
FAKE_HOME=""
STUB_DIR=""
PG_RUNNING=0

# Bootstrap-password contract — see gc-provision.test.sh for the
# rationale (CV-1 + the env-set-always shellout invariant from
# src/lib/pg-query.js).
export PGPASSWORD="${PGPASSWORD:-postgres}"

cleanup() {
  if [[ "$PG_RUNNING" -eq 1 && -n "$PG_DATA" ]]; then
    pg_ctl -D "$PG_DATA" stop -m immediate -s >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_VERIFY_SLUG_TEST_DIR:-0}" -eq 1 ]]; then
    note "KEEP_VERIFY_SLUG_TEST_DIR=1 — keeping $WORK_DIR"
    return
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

setup() {
  require_postgres
  WORK_DIR="$(mktemp -d -t pgserve-verify-slug-XXXXXX)"
  PG_DATA="${WORK_DIR}/data"
  PG_LOG="${WORK_DIR}/postgres.log"
  SOCKET_DIR="${WORK_DIR}/socket"
  FAKE_HOME="${WORK_DIR}/home"
  STUB_DIR="${WORK_DIR}/stub-cosign"

  mkdir -p "$SOCKET_DIR" "$FAKE_HOME" "$STUB_DIR"

  # initdb — see gc-provision.test.sh for the `-U postgres` rationale.
  initdb -D "$PG_DATA" -U postgres --auth-local=trust --auth-host=trust -E UTF8 -A trust >/dev/null 2>&1 \
    || { echo "initdb failed; check $PG_LOG" >&2; exit 2; }

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

  psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres -c "SELECT 1" >/dev/null \
    || { echo "psql connect failed" >&2; exit 2; }
  ok "postgres up on port ${PORT} (data: ${PG_DATA})"
}

stage_stub_cosign() {
  local node_path
  node_path="$(command -v node)"
  if [[ -z "$node_path" ]]; then
    note "node not on PATH — cannot stage stub cosign"
    exit 2
  fi

  cat >"${STUB_DIR}/cosign" <<COSIGN
#!${node_path}
const fs = require('node:fs');
const args = process.argv.slice(2);
// Log every cosign call for assertion replay if needed.
const callLog = ${STUB_DIR@Q} + '/calls.log';
fs.appendFileSync(callLog, JSON.stringify(args) + '\\n');
if (args[0] !== 'verify-blob') process.exit(2);

// Find --certificate-identity-regexp value + the trailing binary path.
let regex = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--certificate-identity-regexp') regex = args[i + 1];
}
const binaryPath = args[args.length - 1];

let body;
try { body = fs.readFileSync(binaryPath, 'utf8'); } catch { process.exit(3); }

// Test contract: the stub accepts ONLY when the identity-regex equals
// the literal '^FROZEN-LOCK\$' AND the binary's first bytes are
// 'FROZEN-LOCK'. Any other identity-regex (live TRUSTED_IDENTITIES
// patterns) or any other binary content: reject.
if (regex === '^FROZEN-LOCK\$' && body.startsWith('FROZEN-LOCK')) {
  process.stdout.write('Verified OK\\n');
  process.exit(0);
}
process.stderr.write('cosign-stub: rejected (regex=' + regex + ')\\n');
process.exit(1);
COSIGN
  chmod +x "${STUB_DIR}/cosign"
  ok "stub cosign staged at ${STUB_DIR}/cosign"
}

# Run a pgserve verb against the worktree's bin/, with HOME + PGHOST
# redirected and the stub cosign prepended onto PATH.
pgserve_run() {
  HOME="$FAKE_HOME" \
  PGHOST="$SOCKET_DIR" \
  PATH="${STUB_DIR}:${PATH}" \
    node "${REPO_ROOT}/bin/autopg-wrapper.cjs" "$@"
}

run_create_app() {
  pgserve_run create-app demo --port "$PORT" --json >"${WORK_DIR}/create-1.json" 2>"${WORK_DIR}/create-1.err" \
    || { bad "create-app demo failed"; cat "${WORK_DIR}/create-1.err" >&2; return 1; }
  ok "create-app demo succeeded (locked live TRUSTED_IDENTITIES)"

  local row_count
  row_count="$(psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres -At -c \
    "SELECT COUNT(*) FROM public.autopg_meta WHERE slug = 'demo'" 2>/dev/null || echo 0)"
  if [[ "$row_count" != "1" ]]; then
    bad "expected exactly 1 autopg_meta row for slug 'demo', got ${row_count}"
    return 1
  fi
  ok "autopg_meta row exists for slug 'demo'"
}

mutate_locked_roots_to_synthetic() {
  # Replace whatever was just frozen with a synthetic single-entry
  # locked_roots that ONLY accepts the FROZEN-LOCK identity pattern.
  # This is the test's stand-in for "operator rotated live
  # TRUSTED_IDENTITIES; the slug's lock is now divergent". When verify
  # --slug demo loads locked_roots, it gets THIS list, not live.
  psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres -c \
    "UPDATE public.autopg_meta SET locked_roots = '[{\"id\":\"frozen-test\",\"publisher\":\"@test/frozen\",\"issuer\":\"https://token.actions.githubusercontent.com\",\"identityRegexp\":\"^FROZEN-LOCK\$\",\"description\":\"test\"}]'::jsonb WHERE slug = 'demo'" \
    >/dev/null 2>&1 \
    || { bad "failed to mutate autopg_meta.locked_roots"; return 1; }
  ok "autopg_meta.locked_roots mutated to synthetic FROZEN-LOCK identity"
}

run_verify_frozen_lock_match() {
  local binary="${WORK_DIR}/frozen-binary"
  printf 'FROZEN-LOCK\nELF...' >"$binary"
  printf '{"fake":"bundle"}' >"${binary}.bundle"

  local rc=0
  pgserve_run verify "$binary" --slug demo --port "$PORT" --no-cache --json \
    >"${WORK_DIR}/verify-frozen.out" 2>"${WORK_DIR}/verify-frozen.err" \
    || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    bad "verify --slug demo against FROZEN-LOCK binary failed (rc=${rc})"
    cat "${WORK_DIR}/verify-frozen.out" >&2
    cat "${WORK_DIR}/verify-frozen.err" >&2
    return 1
  fi
  ok "verify <FROZEN-LOCK binary> --slug demo exits 0 (matched the lock)"
}

run_verify_lock_rejects_live_identity() {
  # Body deliberately starts with a string that is NOT 'FROZEN-LOCK',
  # so the stub cosign would reject it under the FROZEN-LOCK identity-
  # regex (which is what `--slug demo` selects). If the verify path
  # incorrectly fell through to live TRUSTED_IDENTITIES, the stub
  # would also reject (wrong identity-regex), so this assertion is
  # robust either way.
  local binary="${WORK_DIR}/live-binary"
  printf 'LIVE-IDENTITY\nELF...' >"$binary"
  printf '{"fake":"bundle"}' >"${binary}.bundle"

  local rc=0
  pgserve_run verify "$binary" --slug demo --port "$PORT" --no-cache --json \
    >"${WORK_DIR}/verify-live.out" 2>"${WORK_DIR}/verify-live.err" \
    || rc=$?
  # Expect non-zero — verify rejection. Acceptance criterion #3 says
  # "exits non-zero" so any rc >= 2 is acceptable. We assert >=2 to
  # exclude exit-1 (which would be a bug — exit-1 is reserved for
  # user-flag errors that never reach verify).
  if [[ "$rc" -lt 2 ]]; then
    bad "verify --slug demo against LIVE-IDENTITY binary should reject; got rc=${rc}"
    cat "${WORK_DIR}/verify-live.out" >&2
    cat "${WORK_DIR}/verify-live.err" >&2
    return 1
  fi
  ok "verify <LIVE-IDENTITY binary> --slug demo exits ${rc} (>=2, lock rejected)"
}

run_verify_unknown_slug_exit_three() {
  local binary="${WORK_DIR}/frozen-binary"
  # Same FROZEN-LOCK binary — slug-unknown should fail BEFORE cosign is
  # even invoked, regardless of the binary content.
  local rc=0
  pgserve_run verify "$binary" --slug nonexistent_slug --port "$PORT" --no-cache --json \
    >"${WORK_DIR}/verify-unknown.out" 2>"${WORK_DIR}/verify-unknown.err" \
    || rc=$?
  if [[ "$rc" -ne 3 ]]; then
    bad "verify --slug nonexistent_slug should exit 3 (invocation); got rc=${rc}"
    cat "${WORK_DIR}/verify-unknown.out" >&2
    cat "${WORK_DIR}/verify-unknown.err" >&2
    return 1
  fi
  ok "verify <binary> --slug nonexistent_slug exits 3 (invocation; loader rejected)"
}

run_idempotent_create_app_preserves_lock() {
  # Re-run create-app demo — must NOT clobber the synthetic locked_roots
  # we placed earlier. Acceptance criterion #1 says the second run only
  # touches last_updated.
  pgserve_run create-app demo --port "$PORT" --json >"${WORK_DIR}/create-2.json" 2>"${WORK_DIR}/create-2.err" \
    || { bad "second create-app demo failed"; cat "${WORK_DIR}/create-2.err" >&2; return 1; }
  ok "second create-app demo succeeded (idempotent)"

  local lock_id
  lock_id="$(psql -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres -At -c \
    "SELECT locked_roots->0->>'id' FROM public.autopg_meta WHERE slug = 'demo'" 2>/dev/null || echo '')"
  if [[ "$lock_id" != "frozen-test" ]]; then
    bad "idempotent re-run clobbered locked_roots; expected id='frozen-test', got '${lock_id}'"
    return 1
  fi
  ok "idempotent re-run preserved locked_roots (id='frozen-test')"
}

main() {
  setup
  stage_stub_cosign
  run_create_app
  mutate_locked_roots_to_synthetic
  run_verify_frozen_lock_match
  run_verify_lock_rejects_live_identity
  run_verify_unknown_slug_exit_three
  run_idempotent_create_app_preserves_lock

  printf '\n  PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
  if [[ "$FAIL" -gt 0 ]]; then
    return 1
  fi
}

main "$@"
