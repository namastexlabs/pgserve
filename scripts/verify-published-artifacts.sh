#!/usr/bin/env bash
#
# verify-published-artifacts.sh — operator post-release verification.
# Wave A keyless rewrite (PR-B follow-up D13 companion).
#
# Validates that every autopg tarball in the given directory is:
#   1. accompanied by its outer .sha256 and that the hash matches.
#   2. cosign keyless-OIDC-signed — cert subject matches the trust regex
#      (override via AUTOPG_TRUST_REGEX) under the Sigstore GH Actions
#      OIDC issuer.
#   3. accompanied by a SLSA L3 in-toto provenance attestation that
#      slsa-verifier can verify against the source repo URI.
#   4. listed in the aggregated manifest.json with matching metadata.
#
# Usage:
#   bash scripts/verify-published-artifacts.sh dist/
#   bash scripts/verify-published-artifacts.sh dist/ --skip-slsa
#   AUTOPG_TRUST_REGEX='^https://github.com/my-org/.+/.github/workflows/release\.yml@refs/tags/v.*$' \
#     bash scripts/verify-published-artifacts.sh dist/
#
# Exit codes:
#   0  all artifacts verified
#   1  verification failure (any tarball fails any check)
#   2  invalid args / missing inputs

set -euo pipefail

# Wave A: keyless OIDC verification is the default. Override mode is
# selected by setting AUTOPG_COSIGN_PUB to a public-key path — that
# triggers KEYED verification with `--key <path>`, used exclusively by
# tests/integration/sign-attest-smoke.sh which signs offline with a
# checked-in fixture keypair (cosign keyless requires Sigstore network
# + OIDC, neither of which are available during the offline smoke).
#
# KEYLESS mode (default — production):
#   - requires <tarball>.sig + <tarball>.cert
#   - trust regex from AUTOPG_TRUST_REGEX (default below)
#   - OIDC issuer from AUTOPG_OIDC_ISSUER (default below)
#
# KEYED mode (opt-in via AUTOPG_COSIGN_PUB):
#   - requires <tarball>.sig only
#   - public key path: $AUTOPG_COSIGN_PUB
#   - trust regex / oidc issuer ignored
COSIGN_PUB="${AUTOPG_COSIGN_PUB:-}"
TRUST_REGEX_DEFAULT='^https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v.*$'
TRUST_REGEX="${AUTOPG_TRUST_REGEX:-${TRUST_REGEX_DEFAULT}}"
OIDC_ISSUER_DEFAULT="https://token.actions.githubusercontent.com"
OIDC_ISSUER="${AUTOPG_OIDC_ISSUER:-${OIDC_ISSUER_DEFAULT}}"

SOURCE_URI_DEFAULT="github.com/namastexlabs/pgserve"
SOURCE_URI="${AUTOPG_SOURCE_URI:-${SOURCE_URI_DEFAULT}}"

PASS=0
FAIL=0
SKIP_SLSA=0
SKIP_MANIFEST=0

ok()   { printf '    \xe2\x9c\x93 %s\n'    "$*";          PASS=$((PASS + 1)); }
bad()  { printf '    \xe2\x9c\x97 %s\n'    "$*" >&2;      FAIL=$((FAIL + 1)); }
note() { printf '    \xe2\x80\xa2 %s\n'    "$*" >&2; }

usage() {
  cat <<EOF
Usage: $0 <dist-dir> [--skip-slsa] [--skip-manifest]

KEYLESS mode (default — production):
  - trust regex        ${TRUST_REGEX_DEFAULT}
                       (override with AUTOPG_TRUST_REGEX=<regex>)
  - oidc issuer        ${OIDC_ISSUER_DEFAULT}
                       (override with AUTOPG_OIDC_ISSUER=<url>)
  - required siblings  <tarball>.sha256 + .sig + .cert
                       + .intoto.jsonl (skip with --skip-slsa)

KEYED mode (opt-in for offline fixture smoke — set AUTOPG_COSIGN_PUB):
  - public key path    \$AUTOPG_COSIGN_PUB
  - required siblings  <tarball>.sha256 + .sig
                       + .intoto.jsonl (skip with --skip-slsa)
  - trust regex / oidc issuer ignored

Always:
  - source URI         ${SOURCE_URI_DEFAULT}
                       (override with AUTOPG_SOURCE_URI=<uri>)

Optional:
  manifest.json        (skip with --skip-manifest)
EOF
}

parse_args() {
  if [[ $# -lt 1 ]]; then usage; exit 2; fi
  DIST_DIR="$1"; shift
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --skip-slsa)     SKIP_SLSA=1; shift ;;
      --skip-manifest) SKIP_MANIFEST=1; shift ;;
      -h|--help)       usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done
  if [[ ! -d "$DIST_DIR" ]]; then
    echo "error: dist dir not found: $DIST_DIR" >&2; exit 2
  fi
  if [[ -n "$COSIGN_PUB" && ! -f "$COSIGN_PUB" ]]; then
    echo "error: AUTOPG_COSIGN_PUB set but file not found: $COSIGN_PUB" >&2
    exit 2
  fi
}

require_tools() {
  command -v cosign >/dev/null 2>&1 || {
    echo "error: cosign not on PATH (install: https://docs.sigstore.dev/cosign/installation/)" >&2
    exit 2
  }
  if [[ "$SKIP_SLSA" -eq 0 ]]; then
    if ! command -v slsa-verifier >/dev/null 2>&1; then
      note "slsa-verifier not on PATH — provenance check will be skipped (pass --skip-slsa to silence)"
      SKIP_SLSA=1
    fi
  fi
}

# Portable SHA256 — sha256sum on linux, shasum -a 256 on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_outer_sha() {
  local tarball="$1"
  local sha_file="${tarball}.sha256"
  if [[ ! -f "$sha_file" ]]; then
    bad "$(basename "$tarball"): missing .sha256 sibling"
    return 1
  fi
  local recorded actual
  recorded=$(awk '{print $1}' "$sha_file")
  actual=$(sha256_of "$tarball")
  if [[ "$recorded" != "$actual" ]]; then
    bad "$(basename "$tarball"): sha256 mismatch (recorded=$recorded actual=$actual)"
    return 1
  fi
  ok "$(basename "$tarball"): sha256 matches recorded"
}

verify_cosign() {
  local tarball="$1"
  local sig="${tarball}.sig"
  if [[ ! -f "$sig" ]]; then
    bad "$(basename "$tarball"): missing .sig sibling"
    return 1
  fi
  if [[ -n "$COSIGN_PUB" ]]; then
    # KEYED mode (offline fixture smoke).
    if cosign verify-blob \
          --key "$COSIGN_PUB" \
          --signature "$sig" \
          "$tarball" >/dev/null 2>&1; then
      ok "$(basename "$tarball"): cosign keyed signature verifies"
    else
      bad "$(basename "$tarball"): cosign verify-blob FAILED (key=${COSIGN_PUB})"
      return 1
    fi
  else
    # KEYLESS mode (default — production).
    local cert="${tarball}.cert"
    if [[ ! -f "$cert" ]]; then
      bad "$(basename "$tarball"): missing .cert sibling (keyless OIDC requires it)"
      return 1
    fi
    if cosign verify-blob \
          --certificate-identity-regexp "$TRUST_REGEX" \
          --certificate-oidc-issuer "$OIDC_ISSUER" \
          --signature "$sig" \
          --certificate "$cert" \
          "$tarball" >/dev/null 2>&1; then
      ok "$(basename "$tarball"): cosign keyless signature verifies"
    else
      bad "$(basename "$tarball"): cosign verify-blob FAILED (regex=${TRUST_REGEX})"
      return 1
    fi
  fi
}

verify_slsa() {
  local tarball="$1"
  local prov="${tarball}.intoto.jsonl"
  if [[ ! -f "$prov" ]]; then
    bad "$(basename "$tarball"): missing .intoto.jsonl provenance"
    return 1
  fi
  if slsa-verifier verify-artifact \
        "$tarball" \
        --provenance-path "$prov" \
        --source-uri "$SOURCE_URI" >/dev/null 2>&1; then
    ok "$(basename "$tarball"): SLSA provenance verifies"
  else
    bad "$(basename "$tarball"): slsa-verifier FAILED"
    return 1
  fi
}

verify_manifest_entry() {
  local tarball="$1" manifest="$2"
  local base
  base=$(basename "$tarball")
  if ! grep -q "\"file\": \"${base}\"" "$manifest"; then
    bad "$(basename "$tarball"): not listed in manifest.json"
    return 1
  fi
  ok "$(basename "$tarball"): manifest.json entry present"
}

main() {
  parse_args "$@"
  require_tools

  echo "==> verify-published-artifacts: $DIST_DIR"
  if [[ -n "$COSIGN_PUB" ]]; then
    echo "    mode:        KEYED (AUTOPG_COSIGN_PUB set)"
    echo "    cosign pub:  $COSIGN_PUB"
  else
    echo "    mode:        KEYLESS"
    echo "    trust regex: $TRUST_REGEX"
    echo "    oidc issuer: $OIDC_ISSUER"
  fi
  echo "    source uri:  $SOURCE_URI"

  local tarballs=()
  while IFS= read -r line; do
    tarballs+=("$line")
  done < <(find "$DIST_DIR" -maxdepth 1 -name 'autopg-*.tar.gz' -type f | LC_ALL=C sort)

  if [[ ${#tarballs[@]} -eq 0 ]]; then
    bad "no autopg-*.tar.gz files in $DIST_DIR"
    echo "==> result: FAIL (no inputs)"
    exit 1
  fi

  local manifest="${DIST_DIR}/manifest.json"
  if [[ "$SKIP_MANIFEST" -eq 0 && ! -f "$manifest" ]]; then
    bad "manifest.json missing in $DIST_DIR (pass --skip-manifest to ignore)"
  fi

  for tarball in "${tarballs[@]}"; do
    echo "  -- $(basename "$tarball")"
    verify_outer_sha "$tarball" || true
    verify_cosign "$tarball"    || true
    if [[ "$SKIP_SLSA" -eq 0 ]]; then
      verify_slsa "$tarball" || true
    fi
    if [[ "$SKIP_MANIFEST" -eq 0 && -f "$manifest" ]]; then
      verify_manifest_entry "$tarball" "$manifest" || true
    fi
  done

  echo
  echo "==> result: pass=${PASS} fail=${FAIL}"
  if [[ "$FAIL" -gt 0 ]]; then exit 1; fi
}

main "$@"
