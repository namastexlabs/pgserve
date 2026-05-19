#!/usr/bin/env bash
#
# fetch-postgres-bins.sh — Group 7 of autopg-distribution-cutover.
#
# Stages PostgreSQL server binaries for one platform under
#   dist/<platform>/autopg/postgres/{bin,share}/
# so the assemble-tarball step can pack a self-contained release.
#
# Source resolution (in priority order):
#   1. Explicit local override — AUTOPG_POSTGRES_LOCAL_DIR=<dir>
#      Useful in CI when binaries are pre-fetched into a runner cache.
#      Expects <dir>/{bin,share}/.
#   2. npm/bun package — AUTOPG_POSTGRES_PKG_VERSION (default reads
#      package.json optionalDependencies). The function pulls
#      @embedded-postgres/<platform-pkg> into a scratch dir and copies
#      its native/{bin,share}/ payload.
#   3. URL template — AUTOPG_POSTGRES_URL_TEMPLATE='https://.../pg-{ver}-{pf}.tar.gz'
#      with placeholders {ver} and {pf}.
#
# Platforms: linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64
#
# Usage:
#   scripts/fetch-postgres-bins.sh --platform linux-x64-glibc
#   scripts/fetch-postgres-bins.sh --all
#   AUTOPG_POSTGRES_LOCAL_DIR=/cache/pg16-linux-x64 scripts/fetch-postgres-bins.sh --platform linux-x64-glibc

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"

PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

# Stage the bundled shared-library tree (libssl.so.1.1, libcrypto.so.1.1,
# libicu*.so.60, libxml2, …) that @embedded-postgres ships under native/lib/.
#
# WITHOUT this the postgres binary cannot start on ANY modern host: its
# DT_NEEDED list references libssl.so.1.1 + libicui18n.so.60 which no
# current distro provides, and its RUNPATH is `$ORIGIN/../lib` — so the
# libs MUST sit at <out>/lib/. The previous fetch logic copied only bin/
# + share/, so every tarball shipped a postgres that died with
# "error while loading shared libraries" (BRIEF-v3-build-fix Bug #1b).
#
# The package also ships pg-symlinks.json: the version symlinks
# (libicui18n.so.60 → libicui18n.so.60.2) that postgres' DT_NEEDED
# resolves through are created by the package's postinstall, which we
# deliberately skip (`npm install --ignore-scripts`). Replay them here so
# the staged tree is self-contained and `postgres --version` works via
# RUNPATH alone (what tests/integration/tarball-smoke.sh --real asserts).
stage_lib_tree() {
  local src_lib="$1" out_dir="$2" symlinks_json="${3:-}"
  if [[ ! -d "$src_lib" ]]; then
    echo "    (no lib/ at ${src_lib}; skipping bundled-lib stage)"
    return 0
  fi
  cp -R "$src_lib" "${out_dir}/lib"
  if [[ -n "$symlinks_json" && -f "$symlinks_json" ]]; then
    node -e '
      const fs = require("fs"), path = require("path");
      const [json, libDir] = process.argv.slice(1);
      const entries = JSON.parse(fs.readFileSync(json, "utf8"));
      let n = 0;
      for (const { source, target } of entries) {
        const linkPath = path.join(libDir, path.basename(target));
        try { fs.unlinkSync(linkPath); } catch {}
        fs.symlinkSync(path.basename(source), linkPath);
        n++;
      }
      console.log(`    ✓ replayed ${n} pg-symlinks into ${libDir}`);
    ' "$symlinks_json" "${out_dir}/lib"
  fi
}

# Map autopg platform tag → npm package suffix used by @embedded-postgres.
# linux-x64-musl + linux-arm64 currently lack a published @embedded-postgres
# package; for those, set AUTOPG_POSTGRES_LOCAL_DIR or AUTOPG_POSTGRES_URL_TEMPLATE.
embedded_pkg_for() {
  case "$1" in
    linux-x64-glibc) echo "linux-x64" ;;
    linux-x64-musl)  echo "" ;;
    # @embedded-postgres/linux-arm64 IS published (same 18.3.0-beta.* line
    # as linux-x64); the mapping was just never wired, so every arm64
    # release build failed "no @embedded-postgres pkg for linux-arm64".
    linux-arm64)     echo "linux-arm64" ;;
    darwin-x64)      echo "darwin-x64" ;;
    darwin-arm64)    echo "darwin-arm64" ;;
    *) return 1 ;;
  esac
}

# URL-template placeholder mapping for the 3rd-source path.
url_pf_for() {
  case "$1" in
    linux-x64-glibc) echo "linux-x86_64-glibc" ;;
    linux-x64-musl)  echo "linux-x86_64-musl" ;;
    linux-arm64)     echo "linux-aarch64" ;;
    darwin-x64)      echo "darwin-x86_64" ;;
    darwin-arm64)    echo "darwin-aarch64" ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: $0 (--platform <p> | --all) [--postgres-version <v>]

Platforms: ${PLATFORMS[*]}

Source priority (first match wins):
  AUTOPG_POSTGRES_LOCAL_DIR   pre-fetched <dir>/{bin,share}/
  AUTOPG_POSTGRES_PKG_VERSION npm @embedded-postgres/<platform-pkg>@<ver>
  AUTOPG_POSTGRES_URL_TEMPLATE 'https://.../pg-{ver}-{pf}.tar.gz'

Defaults:
  --postgres-version reads optionalDependencies @embedded-postgres/* version
EOF
}

parse_args() {
  TARGET_PLATFORM=""
  FETCH_ALL=0
  PG_VERSION="${AUTOPG_POSTGRES_PKG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform)         TARGET_PLATFORM="$2"; shift 2 ;;
      --all)              FETCH_ALL=1; shift ;;
      --postgres-version) PG_VERSION="$2"; shift 2 ;;
      -h|--help)          usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  if [[ "$FETCH_ALL" -eq 0 && -z "$TARGET_PLATFORM" ]]; then
    echo "error: pass --platform <p> or --all" >&2
    usage; exit 2
  fi

  if [[ -z "$PG_VERSION" ]]; then
    PG_VERSION=$(node -p "require('${REPO_ROOT}/package.json').optionalDependencies['@embedded-postgres/linux-x64'] || ''" 2>/dev/null || true)
  fi
}

stage_from_local() {
  local local_dir="$1" out_dir="$2"
  echo "    -> source: AUTOPG_POSTGRES_LOCAL_DIR=$local_dir"
  if [[ ! -d "$local_dir/bin" ]]; then
    echo "error: $local_dir/bin missing" >&2; return 1
  fi
  cp -R "$local_dir/bin"   "$out_dir/bin"
  cp -R "$local_dir/share" "$out_dir/share" 2>/dev/null || mkdir -p "$out_dir/share"
  stage_lib_tree "$local_dir/lib" "$out_dir"
}

stage_from_pkg() {
  local pkg="$1" version="$2" out_dir="$3"
  echo "    -> source: npm @embedded-postgres/${pkg}@${version}"
  # Initialize before installing trap — under `set -u` the RETURN trap fires
  # on any early-return path, including ones where `mktemp` hasn't run yet.
  # Referencing an unset `$scratch` from the trap would print
  # `scratch: unbound variable` and mask the real fetch error
  # (chatgpt-codex P2 review on PR #84).
  local scratch=""
  trap 'rm -rf "${scratch:-}"' RETURN
  scratch=$(mktemp -d) || return 1

  pushd "$scratch" >/dev/null
  cat > package.json <<EOF
{ "name": "autopg-pg-fetch", "version": "0.0.0", "private": true,
  "dependencies": { "@embedded-postgres/${pkg}": "${version}" } }
EOF

  # Use npm; bun pulls into a different layout.
  if ! npm install --no-audit --no-fund --silent --ignore-scripts; then
    popd >/dev/null
    echo "error: npm install failed for @embedded-postgres/${pkg}@${version}" >&2
    return 1
  fi

  local native="node_modules/@embedded-postgres/${pkg}/native"
  if [[ ! -d "$native" ]]; then
    popd >/dev/null
    echo "error: native/ missing in @embedded-postgres/${pkg} payload" >&2
    return 1
  fi

  cp -R "${native}/bin"   "${out_dir}/bin"
  cp -R "${native}/share" "${out_dir}/share" 2>/dev/null || mkdir -p "${out_dir}/share"
  stage_lib_tree "${native}/lib" "${out_dir}" "${native}/pg-symlinks.json"
  popd >/dev/null
}

stage_from_url() {
  local template="$1" version="$2" platform="$3" out_dir="$4"
  local pf
  pf="$(url_pf_for "$platform")" || { echo "error: no url mapping for $platform" >&2; return 1; }
  local url="${template//\{ver\}/$version}"
  url="${url//\{pf\}/$pf}"
  echo "    -> source: $url"

  local scratch
  scratch=$(mktemp -d)
  trap 'rm -rf "${scratch:-}"' RETURN

  curl -fsSL "$url" -o "${scratch}/pg.tar.gz"
  tar -xzf "${scratch}/pg.tar.gz" -C "$scratch"

  # Find the first directory containing bin/postgres.
  local root postgres_path
  postgres_path=$(find "$scratch" -mindepth 1 -maxdepth 4 -type f -name postgres -path '*/bin/*' -print -quit)
  if [[ -n "$postgres_path" ]]; then
    root=$(dirname "$(dirname "$postgres_path")")
  else
    root=""
  fi
  if [[ -z "$root" ]]; then
    echo "error: bin/postgres not found in extracted tarball" >&2
    return 1
  fi
  cp -R "${root}/bin"   "${out_dir}/bin"
  cp -R "${root}/share" "${out_dir}/share" 2>/dev/null || mkdir -p "${out_dir}/share"
  stage_lib_tree "${root}/lib" "${out_dir}"
}

fetch_one() {
  local platform="$1"
  local out_dir="${DIST_DIR}/${platform}/autopg/postgres"
  rm -rf "$out_dir" || return 1
  mkdir -p "$out_dir" || return 1

  echo "==> [${platform}] fetch postgres bins"

  # `fetch_one` runs without `set -e` (called via `|| rc=$?` in main), so each
  # stage_* helper must propagate failures explicitly (gemini PR #84 HIGH).
  if [[ -n "${AUTOPG_POSTGRES_LOCAL_DIR:-}" ]]; then
    stage_from_local "$AUTOPG_POSTGRES_LOCAL_DIR" "$out_dir" || return 1
  elif [[ -n "$PG_VERSION" ]]; then
    local pkg
    pkg="$(embedded_pkg_for "$platform")" || true
    if [[ -n "$pkg" ]]; then
      stage_from_pkg "$pkg" "$PG_VERSION" "$out_dir" || return 1
    elif [[ -n "${AUTOPG_POSTGRES_URL_TEMPLATE:-}" ]]; then
      stage_from_url "$AUTOPG_POSTGRES_URL_TEMPLATE" "$PG_VERSION" "$platform" "$out_dir" || return 1
    else
      echo "error: no @embedded-postgres pkg for ${platform}; set AUTOPG_POSTGRES_URL_TEMPLATE or AUTOPG_POSTGRES_LOCAL_DIR" >&2
      return 1
    fi
  elif [[ -n "${AUTOPG_POSTGRES_URL_TEMPLATE:-}" ]]; then
    stage_from_url "$AUTOPG_POSTGRES_URL_TEMPLATE" "${AUTOPG_POSTGRES_URL_VERSION:-16}" "$platform" "$out_dir"
  else
    echo "error: no postgres source resolved for ${platform}" >&2
    return 1
  fi

  if [[ ! -x "${out_dir}/bin/postgres" ]]; then
    chmod +x "${out_dir}/bin/postgres" 2>/dev/null || true
  fi
  if [[ ! -f "${out_dir}/bin/postgres" ]]; then
    echo "error: ${out_dir}/bin/postgres missing after stage" >&2
    return 1
  fi
  echo "    ✓ staged ${out_dir} ($(du -sh "$out_dir" | cut -f1))"
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"

  local rc=0
  if [[ "$FETCH_ALL" -eq 1 ]]; then
    for p in "${PLATFORMS[@]}"; do
      fetch_one "$p" || rc=$?
    done
  else
    fetch_one "$TARGET_PLATFORM" || rc=$?
  fi
  exit $rc
}

main "$@"
