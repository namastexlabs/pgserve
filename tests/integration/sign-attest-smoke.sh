#!/usr/bin/env bash
#
# sign-attest-smoke.sh — Group 8 of autopg-distribution-cutover.
#
# Exercises the cosign-sign / aggregate-manifest / verify pipeline
# end-to-end on a *fixture* keypair so the contract is testable on
# any host (no network, no GH OIDC required).
#
# Pipeline:
#   1) build a synthetic "tarball" for each platform
#   2) sign each with the fixture key
#   3) aggregate manifest.json
#   4) verify-published-artifacts.sh succeeds
#   5) tamper one tarball -> verify fails with non-zero exit
#   6) drop one .sig sibling -> verify fails (sig missing)
#
# Group 8 acceptance criteria mirrored:
#   - cosign verify-blob succeeds for every platform tarball
#   - tampered tarball fails cosign verification
#   - script exits non-zero if any tarball ships without sig
#
# (slsa-verifier is gated behind --skip-slsa here because real SLSA
# attestations require GH OIDC + a real workflow run.)
#
# Exit codes:
#   0  pass
#   1  fail (assertion missed)
#   2  invalid setup

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="${REPO_ROOT}/tests/fixtures/cosign"
WORK_DIR="${AUTOPG_DIST_DIR:-$(mktemp -d -t autopg-sign-attest-XXXXXX)}"
VERSION="${AUTOPG_VERSION:-2.260503.1-fixture}"
PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

PASS=0
FAIL=0

ok()   { printf '    \xe2\x9c\x93 %s\n' "$*";          PASS=$((PASS + 1)); }
bad()  { printf '    \xe2\x9c\x97 %s\n' "$*" >&2;      FAIL=$((FAIL + 1)); }
note() { printf '    \xe2\x80\xa2 %s\n' "$*" >&2; }

require_cosign() {
  if ! command -v cosign >/dev/null 2>&1; then
    note "cosign not on PATH — skipping (suite requires cosign installed)"
    exit 0
  fi
  if [[ ! -f "${FIXTURE_DIR}/cosign.key" || ! -f "${FIXTURE_DIR}/cosign.pub" ]]; then
    echo "error: fixture keypair missing at ${FIXTURE_DIR}" >&2
    exit 2
  fi
}

cleanup() {
  if [[ "${AUTOPG_KEEP_DIST:-0}" -eq 1 ]]; then
    note "AUTOPG_KEEP_DIST=1 — keeping ${WORK_DIR}"
    return
  fi
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

stage_synthetic_tarballs() {
  echo "==> staging synthetic tarballs in ${WORK_DIR}"
  mkdir -p "${WORK_DIR}"
  for p in "${PLATFORMS[@]}"; do
    local tar="${WORK_DIR}/autopg-${VERSION}-${p}.tar.gz"
    # Each tarball is a unique 1KB blob so SHAs differ across platforms.
    head -c 1024 /dev/urandom > "${tar}"
    sha256sum "${tar}" | awk '{print $1}' > "${tar}.sha256"
  done
  ls "${WORK_DIR}"
}

sign_each() {
  echo "==> signing each tarball with fixture key"
  local pwd_env
  pwd_env="autopg-fixture"
  for p in "${PLATFORMS[@]}"; do
    local tar="${WORK_DIR}/autopg-${VERSION}-${p}.tar.gz"
    COSIGN_PASSWORD="${pwd_env}" cosign sign-blob \
      --yes \
      --key "${FIXTURE_DIR}/cosign.key" \
      --output-signature "${tar}.sig" \
      "${tar}" 2>/dev/null
    # synthetic provenance — slsa-verifier is skipped in this fixture.
    printf '{"_type":"in-toto-test","subject":[{"name":"%s"}]}\n' \
      "$(basename "${tar}")" > "${tar}.intoto.jsonl"
  done

  for p in "${PLATFORMS[@]}"; do
    local tar="${WORK_DIR}/autopg-${VERSION}-${p}.tar.gz"
    if cosign verify-blob \
        --key "${FIXTURE_DIR}/cosign.pub" \
        --signature "${tar}.sig" \
        "${tar}" >/dev/null 2>&1; then
      ok "${p}: cosign verifies against fixture key"
    else
      bad "${p}: cosign self-check FAILED"
    fi
  done
}

aggregate() {
  echo "==> aggregate manifest.json"
  AUTOPG_DIST_DIR="${WORK_DIR}" bash "${REPO_ROOT}/scripts/aggregate-manifest.sh" \
    --version "${VERSION}" --base-url "https://cdn.example/autopg/test/${VERSION}"
  if [[ -f "${WORK_DIR}/manifest.json" ]]; then
    ok "manifest.json written"
  else
    bad "manifest.json missing"
    return 1
  fi
  if grep -q "\"version\": \"${VERSION}\"" "${WORK_DIR}/manifest.json"; then
    ok "manifest.json carries version"
  else
    bad "manifest.json version field missing"
  fi
  for p in "${PLATFORMS[@]}"; do
    if grep -q "\"platform\": \"${p}\"" "${WORK_DIR}/manifest.json"; then
      ok "manifest.json lists ${p}"
    else
      bad "manifest.json missing ${p}"
    fi
  done
}

happy_path() {
  echo "==> verify-published-artifacts.sh (happy path)"
  if AUTOPG_COSIGN_PUB="${FIXTURE_DIR}/cosign.pub" \
       bash "${REPO_ROOT}/scripts/verify-published-artifacts.sh" \
       "${WORK_DIR}" --skip-slsa >/dev/null 2>&1; then
    ok "verify exits 0 on clean dist"
  else
    bad "verify exits non-zero on clean dist"
  fi
}

tamper_path() {
  echo "==> verify-published-artifacts.sh (tamper)"
  local victim="${WORK_DIR}/autopg-${VERSION}-${PLATFORMS[0]}.tar.gz"
  # Append one byte; outer .sha256 stays old, cosign sig stays old.
  printf 'X' >> "${victim}"
  if AUTOPG_COSIGN_PUB="${FIXTURE_DIR}/cosign.pub" \
       bash "${REPO_ROOT}/scripts/verify-published-artifacts.sh" \
       "${WORK_DIR}" --skip-slsa >/dev/null 2>&1; then
    bad "verify accepted tampered tarball (should fail)"
  else
    ok "verify rejects tampered tarball"
  fi
  # Restore so the next assertion is independent.
  truncate -s -1 "${victim}"
  sha256sum "${victim}" | awk '{print $1}' > "${victim}.sha256"
}

missing_sig_path() {
  echo "==> verify-published-artifacts.sh (missing .sig)"
  local victim="${WORK_DIR}/autopg-${VERSION}-${PLATFORMS[1]}.tar.gz"
  local stash="${victim}.sig.stash"
  mv "${victim}.sig" "${stash}"
  if AUTOPG_COSIGN_PUB="${FIXTURE_DIR}/cosign.pub" \
       bash "${REPO_ROOT}/scripts/verify-published-artifacts.sh" \
       "${WORK_DIR}" --skip-slsa >/dev/null 2>&1; then
    bad "verify accepted tarball with no .sig (should fail)"
  else
    ok "verify rejects tarball with no .sig sibling"
  fi
  mv "${stash}" "${victim}.sig"
}

main() {
  require_cosign
  stage_synthetic_tarballs
  sign_each
  aggregate
  happy_path
  tamper_path
  missing_sig_path

  echo
  echo "==> result: pass=${PASS} fail=${FAIL}"
  if [[ "${FAIL}" -gt 0 ]]; then exit 1; fi
}

main "$@"
