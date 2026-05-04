#!/usr/bin/env bash
#
# install-sh-fresh-host.sh — Group 10 of autopg-distribution-cutover.
#
# Hermetic fixture validator for install.sh. We do NOT touch the public
# CDN. The test stages a synthetic signed bundle to a local directory,
# points install.sh at it via AUTOPG_CDN_BASE=file://..., shims out the
# bun/pm2 prereqs (and cosign/slsa-verifier when present) so the script
# is exercised end-to-end without root, network, or postgres on the host.
#
# Acceptance assertions (Group 10):
#   A1. wc -l install.sh ≤ 80
#   A2. shellcheck install.sh exits 0 with no warnings
#   A3. Happy-path install.sh:
#       - resolves channel pointer + manifest entry for current platform
#       - fetches tarball, verifies sha256, extracts to ${HOME}/.autopg/install/<v>/
#       - exec's ${HOME}/.autopg/install/<v>/autopg/autopg install --non-interactive
#         (recorded by a stub binary that writes its argv to a sentinel file)
#   A4. Tampered tarball aborts install.sh with a sha256-mismatch message and
#       does NOT invoke the stub binary.
#   A5. install.sh on Windows native (uname shim → MINGW32_NT-10.0) prints the
#       locked rejection string and exits 1.
#
# Wish-validation contract:
#   bash tests/integration/install-sh-fresh-host.sh
#
# Exit codes:
#   0  pass
#   1  fail (assertion missed)
#   2  invalid args / missing inputs

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"
PUBLISH_SCRIPT="${REPO_ROOT}/scripts/cdn-publish.sh"
AGGREGATE_SCRIPT="${REPO_ROOT}/scripts/aggregate-manifest.sh"

VERSION="2.260503.1-fixture"
CHANNEL="stable"
WORK_ROOT=""
KEEP_WORK="${AUTOPG_KEEP_WORK:-0}"
PASS=0
FAIL=0

ok()   { printf '    \xe2\x9c\x93 %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '    \xe2\x9c\x97 %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }
note() { printf '    \xe2\x80\xa2 %s\n' "$*"; }

cleanup() {
  if [[ "$KEEP_WORK" -eq 1 ]]; then
    note "AUTOPG_KEEP_WORK=1 — keeping ${WORK_ROOT}"
    return
  fi
  [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]] && rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

require() {
  local f="$1" what="$2"
  [[ -e "$f" ]] || { echo "error: ${what} not found at ${f}" >&2; exit 2; }
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Detect what install.sh's detect_platform() would emit on this host so we
# can synthesize the matching tarball name. We deliberately reuse the same
# code path the script uses to keep the contract exercised.
detect_platform() {
  local m s; m="$(uname -m)"; s="$(uname -s)"
  case "${s}__${m}" in
    Darwin__x86_64) echo darwin-x64 ;;
    Darwin__arm64|Darwin__aarch64) echo darwin-arm64 ;;
    Linux__x86_64) if ldd --version 2>&1 | grep -qi musl; then echo linux-x64-musl; else echo linux-x64-glibc; fi ;;
    Linux__aarch64|Linux__arm64) echo linux-arm64 ;;
    *) echo unknown-platform ;;
  esac
}

# Build a tiny tarball whose `autopg/autopg` is a stub that records argv.
make_stub_tarball() {
  local out_dir="$1" platform="$2" sentinel="$3"
  local stage; stage="$(mktemp -d -t autopg-stage-XXXXXX)"
  mkdir -p "${stage}/autopg"
  cat > "${stage}/autopg/autopg" <<EOF
#!/usr/bin/env bash
# install-sh-fresh-host.sh stub — records argv to a sentinel file.
printf '%s\\0' "\$@" >> '${sentinel}'
exit 0
EOF
  chmod +x "${stage}/autopg/autopg"
  printf 'stub %s %s\n' "$VERSION" "$platform" > "${stage}/autopg/VERSION"
  ( cd "$stage" && tar -czf "${out_dir}/autopg-${VERSION}-${platform}.tar.gz" autopg )
  rm -rf "$stage"
}

stage_bundle() {
  local bundle="$1" platform="$2" sentinel="$3"
  mkdir -p "$bundle"
  # Only the host-platform tarball needs real content — install.sh only
  # touches its matching entry. Build dummy 256-byte tarballs for the rest
  # so aggregate-manifest can produce a 5-platform manifest.
  local platforms=(linux-x64-glibc linux-x64-musl linux-arm64 darwin-x64 darwin-arm64)
  for p in "${platforms[@]}"; do
    local tar="${bundle}/autopg-${VERSION}-${p}.tar.gz"
    if [[ "$p" == "$platform" ]]; then
      make_stub_tarball "$bundle" "$p" "$sentinel"
    else
      head -c 256 /dev/urandom > "$tar"
    fi
    sha256_of "$tar" > "${tar}.sha256"
    printf 'sig-stub-%s\n' "$p" > "${tar}.sig"
    printf '{"_type":"in-toto-test","subject":[{"name":"%s"}]}\n' \
      "$(basename "$tar")" > "${tar}.intoto.jsonl"
  done

  AUTOPG_DIST_DIR="$bundle" bash "$AGGREGATE_SCRIPT" \
    --version "$VERSION" \
    --channel "$CHANNEL" \
    --base-url "" \
    --cosign-pub-url "../../keys/cosign.pub" \
    >/dev/null
}

publish_local() {
  local bundle="$1" target="$2"
  bash "$PUBLISH_SCRIPT" \
    --bundle "$bundle" \
    --channel "$CHANNEL" \
    --version "$VERSION" \
    --backend local \
    --target "$target" \
    --publish-key \
    --cosign-pub "${REPO_ROOT}/keys/cosign.pub" \
    >/dev/null
}

# Build a stub PATH that satisfies install.sh's prereq probes without
# touching the real bun/pm2/cosign. We keep curl/sha256sum/awk/sed/tar
# from the host PATH so the script's actual logic runs.
stub_path() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  # bun + pm2: prereq probes; install.sh just calls them but doesn't depend
  # on their output. cosign + slsa-verifier: install.sh would otherwise
  # invoke the host-installed binary against a fixture sig that isn't a
  # real signature; stubbing them keeps the test hermetic. The wiring
  # itself (correct argv shape) is already enforced by the script reaching
  # this point — a missing stub bin would fall back to the "missing — skip"
  # branch and silently pass, which is why the stubs exit 0.
  for b in bun pm2 cosign slsa-verifier; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "${stub_dir}/${b}"
    chmod +x "${stub_dir}/${b}"
  done
  printf '%s:%s\n' "$stub_dir" "$PATH"
}

# Build a `uname` shim that fakes a Windows native host so we can drive
# install.sh's locked rejection path.
windows_uname_shim() {
  local stub_dir="$1"
  mkdir -p "$stub_dir"
  cat > "${stub_dir}/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo "MINGW32_NT-10.0" ;;
  -m) echo "x86_64" ;;
  *)  echo "unknown" ;;
esac
EOF
  chmod +x "${stub_dir}/uname"
  printf '%s:%s\n' "$stub_dir" "$PATH"
}

assert_lines_under_80() {
  local lines; lines=$(wc -l < "$INSTALL_SH" | awk '{print $1}')
  if [[ "$lines" -le 80 ]]; then ok "wc -l install.sh = ${lines} (≤ 80)"
  else bad "wc -l install.sh = ${lines} (> 80)"; fi
}

assert_shellcheck_clean() {
  if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck "$INSTALL_SH" >/tmp/.shellcheck.$$ 2>&1; then
      ok "shellcheck install.sh — 0 warnings"
    else
      bad "shellcheck install.sh — see /tmp/.shellcheck.$$"
      cat /tmp/.shellcheck.$$ >&2
    fi
    rm -f /tmp/.shellcheck.$$
  else
    note "shellcheck not present — skipping (CI must have it)"
  fi
}

assert_happy_path() {
  local platform="$1" target="$2" sentinel="$3"
  local fake_home="${WORK_ROOT}/home-happy"
  mkdir -p "$fake_home"
  local stub_dir="${WORK_ROOT}/stub-bin"
  local PATH_WITH_STUBS; PATH_WITH_STUBS="$(stub_path "$stub_dir")"
  echo "==> happy-path install.sh (platform=${platform})"
  if HOME="$fake_home" PATH="$PATH_WITH_STUBS" \
       AUTOPG_CDN_BASE="file://${target}/autopg" AUTOPG_CHANNEL="$CHANNEL" \
       bash "$INSTALL_SH" >"${WORK_ROOT}/happy.log" 2>&1; then
    ok "install.sh exited 0"
  else
    bad "install.sh failed (see ${WORK_ROOT}/happy.log)"
    sed 's/^/        /' "${WORK_ROOT}/happy.log" >&2
    return
  fi
  local install_dir="${fake_home}/.autopg/install/${VERSION}/autopg"
  if [[ -x "${install_dir}/autopg" ]]; then
    ok "tarball extracted to ${install_dir}"
  else bad "expected ${install_dir}/autopg, not found"; fi
  if [[ -s "$sentinel" ]] && grep -aq 'install' "$sentinel" \
       && grep -aq 'non-interactive' "$sentinel"; then
    ok "stub autopg invoked with 'install --non-interactive'"
  else
    bad "stub autopg sentinel missing required argv (sentinel=${sentinel})"
    [[ -f "$sentinel" ]] && tr '\0' ' ' < "$sentinel" >&2
  fi
  if [[ -f "${fake_home}/.autopg/cosign.pub" ]]; then
    ok "cosign.pub fetched to fake \$HOME/.autopg/cosign.pub"
  else bad "cosign.pub missing under \$HOME/.autopg/"; fi
}

assert_tamper_path() {
  local platform="$1" target="$2"
  local fake_home="${WORK_ROOT}/home-tamper"
  mkdir -p "$fake_home"
  local stub_dir="${WORK_ROOT}/stub-bin-tamper"
  local PATH_WITH_STUBS; PATH_WITH_STUBS="$(stub_path "$stub_dir")"
  local tarball="${target}/autopg/${CHANNEL}/${VERSION}/autopg-${VERSION}-${platform}.tar.gz"
  echo "==> tamper-path install.sh (corrupt tarball post-publish)"
  printf 'TAMPERED' > "$tarball"
  local code=0
  HOME="$fake_home" PATH="$PATH_WITH_STUBS" \
    AUTOPG_CDN_BASE="file://${target}/autopg" AUTOPG_CHANNEL="$CHANNEL" \
    bash "$INSTALL_SH" >"${WORK_ROOT}/tamper.log" 2>&1 || code=$?
  if [[ "$code" -ne 0 ]] && grep -q 'sha256 mismatch' "${WORK_ROOT}/tamper.log"; then
    ok "install.sh aborted on sha256 mismatch (exit ${code})"
  else
    bad "tamper path expected non-zero exit + 'sha256 mismatch' (exit=${code})"
    sed 's/^/        /' "${WORK_ROOT}/tamper.log" >&2
  fi
  if [[ ! -d "${fake_home}/.autopg/install/${VERSION}" ]]; then
    ok "no install dir created on tamper path"
  else bad "install dir leaked despite sha256 abort"; fi
}

assert_windows_rejection() {
  local fake_home="${WORK_ROOT}/home-win"
  mkdir -p "$fake_home"
  local stub_dir="${WORK_ROOT}/stub-bin-win"
  local PATH_WITH_STUBS; PATH_WITH_STUBS="$(windows_uname_shim "$stub_dir")"
  echo "==> windows-rejection install.sh"
  local code=0
  HOME="$fake_home" PATH="$PATH_WITH_STUBS" \
    bash "$INSTALL_SH" >"${WORK_ROOT}/win.log" 2>&1 || code=$?
  if [[ "$code" -eq 1 ]] \
       && grep -Fq 'Windows native is not supported. Use WSL: see https://docs.automagik.dev/autopg/wsl' "${WORK_ROOT}/win.log"; then
    ok "install.sh rejected Windows native with locked string + exit 1"
  else
    bad "windows-rejection: expected exit 1 + locked string (exit=${code})"
    sed 's/^/        /' "${WORK_ROOT}/win.log" >&2
  fi
}

main() {
  require "$INSTALL_SH"       "install.sh"
  require "$PUBLISH_SCRIPT"   "scripts/cdn-publish.sh"
  require "$AGGREGATE_SCRIPT" "scripts/aggregate-manifest.sh"

  WORK_ROOT="$(mktemp -d -t autopg-install-sh-XXXXXX)"
  local platform; platform="$(detect_platform)"
  if [[ "$platform" == "unknown-platform" ]]; then
    echo "error: this host's uname combo is not in install.sh's matrix; cannot exercise happy path" >&2
    exit 2
  fi
  local bundle="${WORK_ROOT}/bundle"
  local target="${WORK_ROOT}/cdn"
  local sentinel="${WORK_ROOT}/stub-argv"
  mkdir -p "$target"
  : > "$sentinel"

  echo "==> detect platform: ${platform}"
  echo "==> stage synthetic signed bundle (${VERSION})"
  stage_bundle "$bundle" "$platform" "$sentinel"
  echo "==> publish to local CDN target"
  publish_local "$bundle" "$target"

  echo "==> assert install.sh size + lint"
  assert_lines_under_80
  assert_shellcheck_clean

  assert_happy_path     "$platform" "$target" "$sentinel"
  assert_tamper_path    "$platform" "$target"
  assert_windows_rejection

  echo
  echo "==> result: pass=${PASS} fail=${FAIL}"
  if [[ "$FAIL" -gt 0 ]]; then exit 1; fi
}

main "$@"
