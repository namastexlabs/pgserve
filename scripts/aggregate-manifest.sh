#!/usr/bin/env bash
#
# aggregate-manifest.sh — Group 8 of autopg-distribution-cutover.
#
# Walks dist/autopg-<version>-<platform>.tar.gz, gathers each tarball's
# SHA256 + signature URL + provenance URL + platform tuple, and emits
# dist/manifest.json that consumers (install.sh, autopg update) read to
# resolve a download for a given (channel, version, platform).
#
# This runs after Group 8 signing + provenance generation and before
# Group 9 (CDN publish).
#
# Usage:
#   bash scripts/aggregate-manifest.sh --version 2.260503.1
#   bash scripts/aggregate-manifest.sh --version 2.260503.1 --base-url https://cdn.automagik.dev/autopg/stable/2.260503.1
#
# Output:
#   dist/manifest.json
#
# Exit codes:
#   0  ok
#   1  IO failure
#   2  invalid args / missing inputs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"

usage() {
  cat <<EOF
Usage: $0 --version <v> [--base-url <url>] [--channel <c>] [--cosign-pub-url <url>]

  --version          autopg version, e.g. 2.260503.1 (or read from package.json)
  --base-url         absolute base URL prefix for tarball URLs
                     (default: relative — consumers resolve against the
                      directory the manifest sits in).
  --channel          channel hint embedded in the manifest (stable|beta|canary).
                     default: stable
  --cosign-pub-url   absolute URL to the published cosign public key.
                     default: <base-url>/../../keys/cosign.pub for production
                     (cdn.automagik.dev layout) or "keys/cosign.pub" relative.

Reads:
  dist/autopg-<version>-<platform>.tar.gz
  dist/autopg-<version>-<platform>.tar.gz.sha256
  dist/autopg-<version>-<platform>.tar.gz.sig          (optional)
  dist/autopg-<version>-<platform>.tar.gz.intoto.jsonl (optional)

Writes:
  dist/manifest.json
EOF
}

parse_args() {
  VERSION="${AUTOPG_VERSION:-}"
  BASE_URL=""
  CHANNEL="stable"
  COSIGN_PUB_URL=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)        VERSION="$2";        shift 2 ;;
      --base-url)       BASE_URL="$2";       shift 2 ;;
      --channel)        CHANNEL="$2";        shift 2 ;;
      --cosign-pub-url) COSIGN_PUB_URL="$2"; shift 2 ;;
      -h|--help)        usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done
  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "")
  fi
  if [[ -z "$VERSION" ]]; then
    echo "error: --version required (or set in package.json)" >&2; exit 2
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

prefix_url() {
  local rel="$1"
  if [[ -n "$BASE_URL" ]]; then
    printf '%s/%s' "${BASE_URL%/}" "$rel"
  else
    printf '%s' "$rel"
  fi
}

emit_entry() {
  local tarball="$1"
  local first="$2"
  local base platform sha sz
  base=$(basename "$tarball")
  # Strip "autopg-<version>-" prefix and ".tar.gz" suffix to get platform.
  platform="${base#autopg-${VERSION}-}"
  platform="${platform%.tar.gz}"

  if [[ ! -f "${tarball}.sha256" ]]; then
    echo "error: ${tarball}.sha256 missing — run assemble-tarball.sh first" >&2
    return 1
  fi
  sha=$(awk '{print $1}' "${tarball}.sha256")
  sz=$(stat -c %s "$tarball" 2>/dev/null || stat -f %z "$tarball")

  local sig_url="" prov_url=""
  if [[ -f "${tarball}.sig" ]]; then
    sig_url=$(prefix_url "${base}.sig")
  fi
  if [[ -f "${tarball}.intoto.jsonl" ]]; then
    prov_url=$(prefix_url "${base}.intoto.jsonl")
  fi

  if [[ "$first" -eq 0 ]]; then printf ',\n'; fi
  printf '    {\n'
  printf '      "platform": "%s",\n' "$platform"
  printf '      "file": "%s",\n'     "$base"
  printf '      "url": "%s",\n'      "$(prefix_url "$base")"
  printf '      "sha256": "%s",\n'   "$sha"
  printf '      "size": %d,\n'       "$sz"
  printf '      "signature_url": "%s",\n' "$sig_url"
  printf '      "provenance_url": "%s"\n' "$prov_url"
  printf '    }'
}

main() {
  parse_args "$@"
  [[ -d "$DIST_DIR" ]] || { echo "error: $DIST_DIR not a directory" >&2; exit 2; }

  local tarballs=()
  while IFS= read -r line; do
    tarballs+=("$line")
  done < <(find "$DIST_DIR" -maxdepth 1 -name "autopg-${VERSION}-*.tar.gz" -type f | LC_ALL=C sort)

  if [[ ${#tarballs[@]} -eq 0 ]]; then
    echo "error: no autopg-${VERSION}-*.tar.gz files in ${DIST_DIR}" >&2
    exit 2
  fi

  local generated_at
  generated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local out="${DIST_DIR}/manifest.json"
  {
    printf '{\n'
    printf '  "name": "autopg",\n'
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "channel": "%s",\n' "$CHANNEL"
    printf '  "schemaVersion": 1,\n'
    printf '  "generated_at": "%s",\n' "$generated_at"
    local cpub
    if [[ -n "$COSIGN_PUB_URL" ]]; then
      cpub="$COSIGN_PUB_URL"
    elif [[ -n "$BASE_URL" ]]; then
      # CDN layout: <base>/autopg/<channel>/<version>/manifest.json
      # Public key lives at: <base>/autopg/keys/cosign.pub
      # If caller passes the full <base>/autopg/<channel>/<version> as
      # base-url, walk two levels up to reach the keys/ sibling.
      cpub="${BASE_URL%/*}"
      cpub="${cpub%/*}/keys/cosign.pub"
    else
      cpub="keys/cosign.pub"
    fi
    printf '  "cosign_pub_url": "%s",\n' "$cpub"
    printf '  "platforms": [\n'
    local first=1
    for t in "${tarballs[@]}"; do
      emit_entry "$t" "$first"
      first=0
    done
    printf '\n  ]\n'
    printf '}\n'
  } > "$out"

  echo "==> manifest: $out ($(wc -l < "$out") lines, ${#tarballs[@]} platforms)"
}

main "$@"
