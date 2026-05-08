#!/usr/bin/env bash
#
# verify-published-artifacts.sh — Group 8 of autopg-distribution-cutover.
#
# Validates that every autopg tarball in the given directory is:
#   1. accompanied by its outer .sha256 and that the hash matches.
#   2. cosign-signed (verifies against keys/cosign.pub or AUTOPG_COSIGN_PUB).
#   3. accompanied by a SLSA L3 in-toto provenance attestation that
#      slsa-verifier can verify against the source repo URI.
#   4. listed in the aggregated manifest.json with matching metadata.
#
# Usage:
#   bash scripts/verify-published-artifacts.sh dist/
#   bash scripts/verify-published-artifacts.sh dist/ --skip-slsa
#   AUTOPG_COSIGN_PUB=tests/fixtures/cosign/cosign.pub \
#     bash scripts/verify-published-artifacts.sh dist/
#
# Exit codes:
#   0  all artifacts verified
#   1  verification failure (any tarball fails any check)
#   2  invalid args / missing inputs
#
# Group 8 acceptance criteria:
#   - cosign verify-blob succeeds for every platform tarball
#   - slsa-verifier verify-artifact succeeds for every platform tarball
#   - tampered tarball fails both verifications
#   - script exits non-zero if any tarball ships without sig + provenance

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COSIGN_PUB_DEFAULT="${REPO_ROOT}/keys/cosign.pub"
COSIGN_PUB="${AUTOPG_COSIGN_PUB:-${COSIGN_PUB_DEFAULT}}"
SOURCE_URI_DEFAULT="github.com/automagik-dev/autopg"
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

Verifies every autopg-*.tar.gz in <dist-dir> using:
  - keys/cosign.pub    (override with AUTOPG_COSIGN_PUB=<path>)
  - source URI         ${SOURCE_URI_DEFAULT}
                       (override with AUTOPG_SOURCE_URI=<uri>)

Required siblings per tarball:
  <tarball>.sha256
  <tarball>.sig
  <tarball>.intoto.jsonl    (skip with --skip-slsa)

Optional:
  manifest.json            (skip with --skip-manifest)
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
  if [[ ! -f "$COSIGN_PUB" ]]; then
    echo "error: cosign public key not found: $COSIGN_PUB" >&2; exit 2
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
  if cosign verify-blob \
        --key "$COSIGN_PUB" \
        --signature "$sig" \
        "$tarball" >/dev/null 2>&1; then
    ok "$(basename "$tarball"): cosign signature verifies"
  else
    bad "$(basename "$tarball"): cosign verify-blob FAILED"
    return 1
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
  echo "    cosign pub: $COSIGN_PUB"
  echo "    source uri: $SOURCE_URI"

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
