#!/usr/bin/env bash
#
# assemble-tarball.sh — Group 7 of autopg-distribution-cutover.
#
# Assembles a single platform tarball with the locked shape:
#
#   autopg/
#     autopg                  # static binary (from build-binary.sh)
#     postgres/
#       bin/*                 # postgres + initdb + libpq + ...
#       share/*               # timezone data, locale, etc.
#     manifest.json           # per-file SHA256 + size
#
# The tarball lives at:
#   dist/autopg-<version>-<platform>.tar.gz
# and a sibling .sha256 file holds the outer hash for Group 8 (cosign sign)
# and Group 9 (CDN publish) to consume.
#
# Inputs come from dist/<platform>/autopg/{autopg, postgres/}, populated by
# build-binary.sh + fetch-postgres-bins.sh.
#
# Usage:
#   scripts/assemble-tarball.sh --platform linux-x64-glibc
#   scripts/assemble-tarball.sh --all --version 2.260503.1

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

usage() {
  cat <<EOF
Usage: $0 (--platform <p> | --all) [--version <v>]

Platforms: ${PLATFORMS[*]}

Inputs (must already exist):
  dist/<platform>/autopg/autopg               (build-binary.sh)
  dist/<platform>/autopg/postgres/bin/*       (fetch-postgres-bins.sh)
  dist/<platform>/autopg/postgres/share/*     (fetch-postgres-bins.sh)

Outputs:
  dist/autopg-<version>-<platform>.tar.gz
  dist/autopg-<version>-<platform>.tar.gz.sha256
EOF
}

parse_args() {
  TARGET_PLATFORM=""
  ASSEMBLE_ALL=0
  VERSION="${AUTOPG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform) TARGET_PLATFORM="$2"; shift 2 ;;
      --all)      ASSEMBLE_ALL=1; shift ;;
      --version)  VERSION="$2"; shift 2 ;;
      -h|--help)  usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  if [[ "$ASSEMBLE_ALL" -eq 0 && -z "$TARGET_PLATFORM" ]]; then
    echo "error: pass --platform <p> or --all" >&2; usage; exit 2
  fi

  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")
  fi
}

# Portable SHA256 — use sha256sum on linux, shasum -a 256 on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Emit manifest.json for the given platform's staged tree.
# Walks autopg/ relative to <root>/, skipping manifest.json itself.
emit_manifest() {
  local root="$1" platform="$2" out="$3"

  pushd "$root" >/dev/null
  {
    printf '{\n'
    printf '  "name": "autopg",\n'
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "platform": "%s",\n' "$platform"
    printf '  "schemaVersion": 1,\n'
    printf '  "files": [\n'

    local first=1
    while IFS= read -r f; do
      [[ "$f" == "autopg/manifest.json" ]] && continue
      local h sz
      h=$(sha256_of "$f")
      sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")
      if [[ $first -eq 1 ]]; then
        first=0
      else
        printf ',\n'
      fi
      printf '    { "path": "%s", "sha256": "%s", "size": %d }' "$f" "$h" "$sz"
    done < <(find autopg -type f | LC_ALL=C sort)

    printf '\n  ]\n'
    printf '}\n'
  } > "$out"
  popd >/dev/null
}

# Verify staged inputs are present + executable.
verify_inputs() {
  local stage="$1" platform="$2"
  local missing=0
  for required in autopg/autopg autopg/postgres/bin/postgres; do
    if [[ ! -f "${stage}/${required}" ]]; then
      echo "error: ${platform}: missing ${required}" >&2
      missing=1
    fi
  done
  return $missing
}

assemble_one() {
  local platform="$1"
  local stage="${DIST_DIR}/${platform}"
  local tarball="${DIST_DIR}/autopg-${VERSION}-${platform}.tar.gz"
  local outer_sha="${tarball}.sha256"

  if [[ ! -d "${stage}/autopg" ]]; then
    echo "error: ${stage}/autopg/ does not exist (run build-binary.sh + fetch-postgres-bins.sh first)" >&2
    return 1
  fi

  echo "==> [${platform}] assemble tarball"
  verify_inputs "$stage" "$platform"

  # 1) emit per-file manifest BEFORE the tarball is rolled — manifest is
  #    bundled inside.
  emit_manifest "$stage" "$platform" "${stage}/autopg/manifest.json"

  # 2) ensure binaries are executable inside the tar.
  chmod +x "${stage}/autopg/autopg" || true
  find "${stage}/autopg/postgres/bin" -type f -exec chmod +x {} +

  # 3) build deterministic tarball: sorted entries, locked mtime.
  local tar_flags=()
  if tar --help 2>&1 | grep -q -- '--sort=name'; then
    tar_flags+=(--sort=name)
  fi
  if tar --help 2>&1 | grep -q -- '--mtime='; then
    tar_flags+=(--mtime=2026-01-01)
  fi
  if tar --help 2>&1 | grep -q -- '--owner='; then
    tar_flags+=(--owner=0 --group=0 --numeric-owner)
  fi

  tar -C "$stage" -czf "$tarball" "${tar_flags[@]}" autopg/
  echo "    ✓ tarball: $tarball ($(du -h "$tarball" | cut -f1))"

  # 4) outer SHA256 — Group 8 cosign-signs this; Group 9 publishes both.
  sha256_of "$tarball" > "$outer_sha"
  echo "    ✓ sha256:  $(cat "$outer_sha")  $(basename "$tarball")"
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"

  local rc=0
  if [[ "$ASSEMBLE_ALL" -eq 1 ]]; then
    for p in "${PLATFORMS[@]}"; do
      assemble_one "$p" || rc=$?
    done
  else
    assemble_one "$TARGET_PLATFORM" || rc=$?
  fi
  exit $rc
}

main "$@"
