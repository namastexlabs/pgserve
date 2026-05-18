#!/usr/bin/env bash
# autopg canonical installer (v2.6+; post-transfer automagik-dev/autopg).
# Fetches the signed binary tarball from GitHub Releases, verifies it
# (gh attestation → cosign verify-blob fallback), and runs `autopg install`.
# Usage:   curl -fsSL https://raw.githubusercontent.com/automagik-dev/autopg/main/install.sh | bash
# Pin:     AUTOPG_VERSION=v2.6.10 curl -fsSL .../install.sh | bash
# Dry-run: bash install.sh --dry-run
# Wish: .genie/wishes/autopg-distribution-cutover-finalize/WISH.md G1
set -euo pipefail

REPO="automagik-dev/autopg"
# Accept the legacy PGSERVE_VERSION pin for backward compat with pre-transfer
# call sites; AUTOPG_VERSION takes precedence when both are set.
VERSION="${AUTOPG_VERSION:-${PGSERVE_VERSION:-latest}}"

# Sigstore keyless identity. The current `latest` (v2.6.10) was signed
# BEFORE the namastexlabs/pgserve → automagik-dev/autopg transfer, so its
# Fulcio cert subject still binds to namastexlabs/pgserve. Post-v3 releases
# bind to automagik-dev/autopg. install.sh is a *consumer* of signing
# artifacts: per the asymmetric-cohort principle it accepts BOTH org
# identities via alternation rather than forcing a producer-side reseal.
IDENTITY_REGEXP='^https://github\.com/(namastexlabs/pgserve|automagik-dev/autopg)/\.github/workflows/sign-attest\.yml@refs/tags/v.*$'
OIDC_ISSUER='https://token.actions.githubusercontent.com'

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# Resolve "latest" tag. Prefer an authenticated `gh api` call (no rate
# limit, robust JSON); fall back to the public unauthenticated endpoint.
if [ "$VERSION" = "latest" ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    VERSION="$(gh api "repos/${REPO}/releases/latest" --jq .tag_name 2>/dev/null || true)"
  fi
  if [ -z "${VERSION:-}" ] || [ "$VERSION" = "latest" ]; then
    VERSION="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  fi
  [ -z "${VERSION:-}" ] && {
    echo "[autopg] could not resolve latest version for ${REPO}." >&2
    echo "[autopg] pin explicitly: AUTOPG_VERSION=vX.Y.Z bash install.sh" >&2
    exit 1
  }
fi

# Detect platform + libc → tarball name. Mirrors release-publish.yml's
# matrix: linux-x64-glibc, linux-x64-musl, linux-arm64, darwin-x64,
# darwin-arm64.
detect_libc() {
  # musl hosts (Alpine etc.) ship ld-musl-*; glibc `ldd --version` says
  # "GNU libc"/"GLIBC". Default to glibc when ambiguous.
  if [ -e /lib/ld-musl-x86_64.so.1 ] || (ldd --version 2>&1 | grep -qi musl); then
    echo musl
  else
    echo glibc
  fi
}
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   PLATFORM="linux-x64-$(detect_libc)" ;;
  Linux-aarch64)  PLATFORM="linux-arm64" ;;
  Darwin-arm64)   PLATFORM="darwin-arm64" ;;
  Darwin-x86_64)  PLATFORM="darwin-x64" ;;
  *)              echo "[autopg] unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

TARBALL="autopg-${VERSION#v}-${PLATFORM}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"
URL="${BASE}/${TARBALL}"

if [ "$DRY_RUN" = "1" ]; then
  echo "[autopg] would fetch:  $URL"
  echo "[autopg] would verify: gh attestation verify (→ cosign verify-blob fallback)"
  echo "[autopg] would extract + run: autopg install"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[autopg] fetching $URL"
curl -fsSL --output "$TMP/$TARBALL" "$URL"

# --- Verification: gh attestation (preferred) → cosign verify-blob -----------
verify_with_gh() {
  command -v gh >/dev/null 2>&1 || return 1
  gh attestation --help >/dev/null 2>&1 || return 1   # gh < 2.49 lacks it
  echo "[autopg] verifying via gh attestation"
  # The attestation predicate binds to the source repo at signing time;
  # for pre-transfer releases that is namastexlabs/pgserve. Try the
  # current repo first, then the legacy owner.
  gh attestation verify "$TMP/$TARBALL" --repo "$REPO" >/dev/null 2>&1 \
    || gh attestation verify "$TMP/$TARBALL" --repo namastexlabs/pgserve >/dev/null 2>&1
}
verify_with_cosign() {
  command -v cosign >/dev/null 2>&1 || return 1
  echo "[autopg] verifying via cosign verify-blob"
  curl -fsSL --output "$TMP/$TARBALL.sig"  "$URL.sig"
  curl -fsSL --output "$TMP/$TARBALL.cert" "$URL.cert"
  cosign verify-blob \
    --certificate-identity-regexp "$IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    --signature "$TMP/$TARBALL.sig" \
    --certificate "$TMP/$TARBALL.cert" \
    "$TMP/$TARBALL" >/dev/null 2>&1
}
if verify_with_gh; then
  echo "[autopg] signature OK (gh attestation)"
elif verify_with_cosign; then
  echo "[autopg] signature OK (cosign verify-blob)"
else
  echo "[autopg] SIGNATURE VERIFICATION FAILED or no verifier available." >&2
  echo "[autopg] install one of:" >&2
  echo "[autopg]   - gh CLI >= 2.49  (https://cli.github.com/)" >&2
  echo "[autopg]   - cosign         (https://docs.sigstore.dev/cosign/installation/)" >&2
  echo "[autopg] then re-run. Refusing to install an unverified binary." >&2
  exit 1
fi
# ---------------------------------------------------------------------------

echo "[autopg] extracting"
tar -xzf "$TMP/$TARBALL" -C "$TMP"

# Tarball ships a top-level `autopg/` dir: autopg/autopg (the binary),
# autopg/manifest.json, autopg/postgres/.
SRC="$TMP/autopg"
[ -x "$SRC/autopg" ] || { echo "[autopg] tarball layout unexpected: $SRC/autopg missing" >&2; exit 1; }

INSTALL_DIR="$HOME/.local/share/autopg/${VERSION}"
mkdir -p "$INSTALL_DIR"
cp -r "$SRC/." "$INSTALL_DIR/"

# Put `autopg` on PATH via the conventional ~/.local/bin symlink so the
# bare `autopg` command resolves after install.
mkdir -p "$HOME/.local/bin"
ln -sf "$INSTALL_DIR/autopg" "$HOME/.local/bin/autopg"
case ":${PATH}:" in
  *":$HOME/.local/bin:"*) : ;;
  *) echo "[autopg] note: add \$HOME/.local/bin to PATH to use the bare 'autopg' command" >&2 ;;
esac

echo "[autopg] installing pm2 supervisor"
"$INSTALL_DIR/autopg" install

echo "[autopg] done — autopg@${VERSION} installed under pm2"
