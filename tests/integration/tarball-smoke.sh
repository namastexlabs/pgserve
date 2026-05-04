#!/usr/bin/env bash
#
# tarball-smoke.sh — Group 7 of autopg-distribution-cutover.
#
# Validates the *shape* of an assembled tarball without depending on
# real postgres binaries. Use this in CI to gate every job in the
# build matrix.
#
# Modes:
#   --fixture     Stage synthetic stub binaries, run the full
#                 build → fetch (stub) → assemble → smoke pipeline.
#                 Does NOT require bun or @embedded-postgres on the
#                 runner; safe for any host.
#   --real        Smoke the real dist/ output produced by the build
#                 matrix. Requires that scripts/build-binary.sh and
#                 scripts/fetch-postgres-bins.sh have already run
#                 against the requested --platform.
#
# Exit codes:
#   0  pass
#   1  fail (assertion missed)
#   2  invalid args / missing inputs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_DIR="${AUTOPG_DIST_DIR:-${REPO_ROOT}/dist}"
PLATFORMS=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)

PASS=0
FAIL=0

ok()   { echo "    ✓ $*";              PASS=$((PASS + 1)); }
fail() { echo "    ✗ $*" >&2;          FAIL=$((FAIL + 1)); }

usage() {
  cat <<EOF
Usage: $0 [--fixture | --real] [--platform <p>] [--version <v>]

  --fixture    Stage synthetic stubs; runs without bun + postgres pkgs.
  --real       Smoke real dist/ output from build matrix.
  --platform   One of: ${PLATFORMS[*]}; default: detect host.
  --version    Default reads package.json.
EOF
}

detect_host_platform() {
  local kernel arch
  kernel=$(uname -s)
  arch=$(uname -m)
  case "${kernel}-${arch}" in
    Linux-x86_64)  echo "linux-x64-glibc" ;;
    Linux-aarch64) echo "linux-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Darwin-arm64)  echo "darwin-arm64" ;;
    *) echo "linux-x64-glibc" ;;
  esac
}

parse_args() {
  MODE="fixture"
  PLATFORM=""
  VERSION="${AUTOPG_VERSION:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fixture) MODE="fixture"; shift ;;
      --real)    MODE="real";    shift ;;
      --platform) PLATFORM="$2"; shift 2 ;;
      --version)  VERSION="$2";  shift 2 ;;
      -h|--help)  usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  [[ -z "$PLATFORM" ]] && PLATFORM="$(detect_host_platform)"
  if [[ -z "$VERSION" ]]; then
    VERSION=$(node -p "require('${REPO_ROOT}/package.json').version" 2>/dev/null || echo "0.0.0")
  fi
}

stage_fixture() {
  echo "==> staging fixture for ${PLATFORM}"
  local stage="${DIST_DIR:?}/${PLATFORM:?}/autopg"
  rm -rf "${DIST_DIR:?}/${PLATFORM:?}"
  mkdir -p "${stage}/postgres/bin" "${stage}/postgres/share"

  cat > "${stage}/autopg" <<EOF
#!/usr/bin/env sh
case "\$1" in
  --version) echo "autopg ${VERSION}" ;;
  *) echo "autopg ${VERSION} (fixture stub)" ;;
esac
EOF
  chmod +x "${stage}/autopg"

  cat > "${stage}/postgres/bin/postgres" <<'EOF'
#!/usr/bin/env sh
echo "postgres (PostgreSQL) 16.10 (fixture stub)"
EOF
  chmod +x "${stage}/postgres/bin/postgres"

  cat > "${stage}/postgres/bin/initdb" <<'EOF'
#!/usr/bin/env sh
echo "initdb (PostgreSQL) 16.10 (fixture stub)"
EOF
  chmod +x "${stage}/postgres/bin/initdb"

  echo 'fixture-timezone-data' > "${stage}/postgres/share/timezone.txt"
}

run_assemble() {
  bash "${REPO_ROOT}/scripts/assemble-tarball.sh" \
    --platform "$PLATFORM" --version "$VERSION"
}

assert_outputs() {
  local tarball="${DIST_DIR}/autopg-${VERSION}-${PLATFORM}.tar.gz"
  local outer_sha="${tarball}.sha256"

  [[ -f "$tarball" ]]   && ok "tarball exists: $(basename "$tarball")" || fail "tarball missing"
  [[ -f "$outer_sha" ]] && ok "outer .sha256 exists" || fail "outer .sha256 missing"

  # outer-sha matches actual content
  local computed
  if command -v sha256sum >/dev/null 2>&1; then
    computed=$(sha256sum "$tarball" | awk '{print $1}')
  else
    computed=$(shasum -a 256 "$tarball" | awk '{print $1}')
  fi
  local recorded
  recorded=$(awk '{print $1}' "$outer_sha")
  [[ "$computed" == "$recorded" ]] && ok "outer SHA256 matches tarball bytes" \
                                   || fail "outer SHA256 drift: $computed vs $recorded"

  # extract + inspect contents
  local scratch
  scratch=$(mktemp -d)
  # shellcheck disable=SC2064  # expand $scratch now, not when trap fires
  trap "rm -rf \"$scratch\"" EXIT

  tar -xzf "$tarball" -C "$scratch"

  for required in \
      autopg/autopg \
      autopg/postgres/bin/postgres \
      autopg/manifest.json; do
    [[ -e "${scratch}/${required}" ]] && ok "tarball contains: ${required}" \
                                       || fail "tarball missing: ${required}"
  done

  # exec — autopg --version reports the right line
  local version_line
  if version_line=$("${scratch}/autopg/autopg" --version 2>/dev/null); then
    if echo "$version_line" | grep -qE "autopg ${VERSION//./\\.}"; then
      ok "autopg --version → ${version_line}"
    else
      fail "autopg --version unexpected: ${version_line}"
    fi
  else
    fail "autopg binary not executable"
  fi

  # exec — postgres --version reports something postgres-shaped
  if version_line=$("${scratch}/autopg/postgres/bin/postgres" --version 2>/dev/null); then
    if echo "$version_line" | grep -qiE "postgres.*\(PostgreSQL\)"; then
      ok "postgres --version → ${version_line}"
    else
      fail "postgres --version unexpected: ${version_line}"
    fi
  else
    fail "postgres binary not executable"
  fi

  # manifest.json sanity
  local manifest="${scratch}/autopg/manifest.json"
  if [[ -f "$manifest" ]]; then
    local pf ver
    pf=$(node -p "require('${manifest}').platform" 2>/dev/null || echo "")
    ver=$(node -p "require('${manifest}').version"  2>/dev/null || echo "")
    [[ "$pf"  == "$PLATFORM" ]] && ok "manifest.platform == ${PLATFORM}" \
                                || fail "manifest.platform drift: ${pf}"
    [[ "$ver" == "$VERSION" ]]  && ok "manifest.version == ${VERSION}" \
                                || fail "manifest.version drift: ${ver}"

    # spot-check one per-file SHA from the manifest
    local first_path first_sha
    first_path=$(node -p "require('${manifest}').files[0].path"   2>/dev/null || echo "")
    first_sha=$( node -p "require('${manifest}').files[0].sha256" 2>/dev/null || echo "")
    if [[ -n "$first_path" && -f "${scratch}/${first_path}" ]]; then
      local recomputed
      if command -v sha256sum >/dev/null 2>&1; then
        recomputed=$(sha256sum "${scratch}/${first_path}" | awk '{print $1}')
      else
        recomputed=$(shasum -a 256 "${scratch}/${first_path}" | awk '{print $1}')
      fi
      [[ "$recomputed" == "$first_sha" ]] && ok "manifest sha matches: ${first_path}" \
                                          || fail "manifest sha drift: ${first_path}"
    else
      fail "manifest.files[0].path not found in tarball"
    fi
  fi
}

main() {
  parse_args "$@"
  mkdir -p "$DIST_DIR"

  echo "==> mode=${MODE} platform=${PLATFORM} version=${VERSION}"

  case "$MODE" in
    fixture)
      stage_fixture
      run_assemble
      ;;
    real)
      if [[ ! -f "${DIST_DIR}/autopg-${VERSION}-${PLATFORM}.tar.gz" ]]; then
        echo "==> --real: tarball missing; running assemble step now"
        run_assemble
      fi
      ;;
    *) echo "error: unknown mode" >&2; exit 2 ;;
  esac

  assert_outputs

  echo
  echo "==> ${PASS} passed, ${FAIL} failed"
  [[ $FAIL -eq 0 ]] || exit 1
}

main "$@"
