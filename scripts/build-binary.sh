#!/usr/bin/env bash
#
# build-binary.sh — Group 7 of autopg-distribution-cutover.
#
# Compiles the autopg CLI to a static binary using `bun build --compile`
# for one or all of the 5 supported platforms:
#
#   linux-x64-glibc, linux-x64-musl, linux-arm64,
#   darwin-x64, darwin-arm64
#
# Outputs land at: dist/<platform>/autopg/autopg
#
# Per the wish G7 fallback contract (distribution-exodus G1): if
# `bun build --compile` fails for a target, retry with `pkg`/`nexe`
# when AUTOPG_BUILD_FALLBACK=1. The fallback is recorded in the build
# log so Group 9's CDN publish can surface it.
#
# Usage:
#   scripts/build-binary.sh --platform linux-x64-glibc
#   scripts/build-binary.sh --all
#   scripts/build-binary.sh --platform darwin-arm64 --version 2.260503.1
#
# Exit codes:
#   0  success
#   1  bun build failed AND fallback disabled or also failed
#   2  invalid arguments / unsupported platform

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# BRIEF-v3-build-fix #10: compile the UNIFIED CLI entry, not bare
# postgres-server.js. bin/autopg-cli.js routes the operator verbs
# (install/verify/doctor/…) through src/cli-install.cjs in-process and
# delegates postmaster/serve to postgres-server.js, so the tarball
# `autopg` has the full verb surface (and install.sh's own `autopg
# install` works). Was `bin/postgres-server.js` → only --version/postmaster.
ENTRY_POINT="${AUTOPG_ENTRY_POINT:-bin/autopg-cli.js}"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"
FALLBACK_ENABLED="${AUTOPG_BUILD_FALLBACK:-0}"

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

# Map autopg platform tag → bun --target value.
bun_target_for() {
  case "$1" in
    linux-x64-glibc) echo "bun-linux-x64" ;;
    linux-x64-musl)  echo "bun-linux-x64-musl" ;;
    linux-arm64)     echo "bun-linux-arm64" ;;
    darwin-x64)      echo "bun-darwin-x64" ;;
    darwin-arm64)    echo "bun-darwin-arm64" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: $0 (--platform <p> | --all) [--version <v>] [--entry <path>]

Platforms: ${PLATFORMS[*]}

Environment:
  AUTOPG_ENTRY_POINT       Override entry file (default: bin/postgres-server.js)
  AUTOPG_DIST_DIR          Override output root (default: \$REPO/dist)
  AUTOPG_BUILD_FALLBACK    Set to 1 to retry failed bun builds via pkg/nexe
EOF
}

parse_args() {
  TARGET_PLATFORM=""
  BUILD_ALL=0
  VERSION="${AUTOPG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform) TARGET_PLATFORM="$2"; shift 2 ;;
      --all)      BUILD_ALL=1; shift ;;
      --version)  VERSION="$2"; shift 2 ;;
      --entry)    ENTRY_POINT="$2"; shift 2 ;;
      -h|--help)  usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  if [[ "$BUILD_ALL" -eq 0 && -z "$TARGET_PLATFORM" ]]; then
    echo "error: pass --platform <p> or --all" >&2
    usage; exit 2
  fi

  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")
  fi
}

build_one() {
  local platform="$1"
  local target
  target="$(bun_target_for "$platform")" || {
    echo "error: unsupported platform: $platform" >&2
    return 2
  }

  local out_dir="${DIST_DIR}/${platform}/autopg"
  # `build_one` runs without `set -e` (called via `|| rc=$?` in main), so
  # mkdir failures must propagate explicitly (gemini PR #84 HIGH review).
  mkdir -p "$out_dir" || return 1
  local outfile="${out_dir}/autopg"

  echo "==> [${platform}] bun build --compile --target=${target}"
  if bun build --compile \
       --target="${target}" \
       --define BUILD_VERSION="'${VERSION}'" \
       "${REPO_ROOT}/${ENTRY_POINT}" \
       --outfile "${outfile}" 2>&1 | tee -a "${DIST_DIR}/build.log"; then
    echo "    ✓ built: ${outfile}"
    record_build "$platform" "bun" "ok"
    return 0
  fi

  echo "    ✗ bun build failed for ${platform}" >&2

  if [[ "$FALLBACK_ENABLED" -eq 1 ]]; then
    echo "==> [${platform}] retry via pkg/nexe (AUTOPG_BUILD_FALLBACK=1)"
    if try_fallback "$platform" "$outfile"; then
      record_build "$platform" "fallback" "ok"
      return 0
    fi
    record_build "$platform" "fallback" "fail"
  else
    record_build "$platform" "bun" "fail"
  fi

  return 1
}

# Fallback: try pkg first, then nexe. Both consume the same entrypoint and
# emit a single executable. We only attempt the fallback when bun fails;
# this is per the distribution-exodus G1 contract.
try_fallback() {
  local platform="$1"
  local outfile="$2"

  if command -v pkg >/dev/null 2>&1; then
    echo "    -> trying pkg"
    local pkg_target
    pkg_target="$(pkg_target_for "$platform")" || return 1
    if pkg --target "$pkg_target" \
           --output "$outfile" \
           "${REPO_ROOT}/${ENTRY_POINT}" 2>&1 | tee -a "${DIST_DIR}/build.log"; then
      echo "    ✓ pkg succeeded"
      return 0
    fi
  fi

  if command -v nexe >/dev/null 2>&1; then
    echo "    -> trying nexe"
    local nexe_target
    nexe_target="$(nexe_target_for "$platform")" || return 1
    if nexe --target "$nexe_target" \
            --output "$outfile" \
            "${REPO_ROOT}/${ENTRY_POINT}" 2>&1 | tee -a "${DIST_DIR}/build.log"; then
      echo "    ✓ nexe succeeded"
      return 0
    fi
  fi

  echo "    ✗ no fallback worked (install pkg or nexe to enable)" >&2
  return 1
}

pkg_target_for() {
  case "$1" in
    linux-x64-glibc) echo "node20-linux-x64" ;;
    linux-x64-musl)  echo "node20-linuxstatic-x64" ;;
    linux-arm64)     echo "node20-linux-arm64" ;;
    darwin-x64)      echo "node20-macos-x64" ;;
    darwin-arm64)    echo "node20-macos-arm64" ;;
    *) return 1 ;;
  esac
}

nexe_target_for() {
  case "$1" in
    linux-x64-glibc) echo "linux-x64-20.0.0" ;;
    linux-x64-musl)  echo "alpine-x64-20.0.0" ;;
    linux-arm64)     echo "linux-arm64-20.0.0" ;;
    darwin-x64)      echo "mac-x64-20.0.0" ;;
    darwin-arm64)    echo "mac-arm64-20.0.0" ;;
    *) return 1 ;;
  esac
}

record_build() {
  local platform="$1" tool="$2" status="$3"
  local rec="${DIST_DIR}/build-record.tsv"
  mkdir -p "$DIST_DIR"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$platform" "$tool" "$status" "$VERSION" >> "$rec"
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"
  : > "${DIST_DIR}/build.log"

  local rc=0
  if [[ "$BUILD_ALL" -eq 1 ]]; then
    for p in "${PLATFORMS[@]}"; do
      build_one "$p" || rc=$?
    done
  else
    build_one "$TARGET_PLATFORM" || rc=$?
  fi

  if [[ $rc -ne 0 ]]; then
    echo "error: at least one build target failed (see ${DIST_DIR}/build.log)" >&2
  fi
  exit $rc
}

main "$@"
