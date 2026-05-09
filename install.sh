#!/usr/bin/env bash
# pgserve canonical installer (v2.6+).
# Fetches the signed binary tarball from GitHub Releases, verifies via
# `gh attestation verify` (Sigstore Rekor), and runs `pgserve install`.
# Usage:   curl -fsSL https://raw.githubusercontent.com/namastexlabs/pgserve/main/install.sh | bash
# Pin:     PGSERVE_VERSION=v2.6.0 curl -fsSL .../install.sh | bash
# Dry-run: bash install.sh --dry-run
# Wish: .genie/wishes/autopg-distribution-cutover-finalize/WISH.md G1
set -euo pipefail

REPO="namastexlabs/pgserve"
VERSION="${PGSERVE_VERSION:-latest}"
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# Resolve "latest" tag without an authenticated gh call (works on any host
# that can reach api.github.com).
if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -z "$VERSION" ] && { echo "[pgserve] could not resolve latest version" >&2; exit 1; }
fi

# Detect platform → tarball name. Matches release-publish.yml's matrix.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   PLATFORM="linux-x64" ;;
  Linux-aarch64)  PLATFORM="linux-arm64" ;;
  Darwin-arm64)   PLATFORM="darwin-arm64" ;;
  Darwin-x86_64)  PLATFORM="darwin-x64" ;;
  *)              echo "[pgserve] unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

TARBALL="pgserve-${VERSION#v}-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

if [ "$DRY_RUN" = "1" ]; then
  echo "[pgserve] would fetch:  $URL"
  echo "[pgserve] would verify: gh attestation verify <tarball> --repo ${REPO}"
  echo "[pgserve] would extract + run: pgserve install"
  exit 0
fi

# Require gh for verification (Sigstore Rekor public-good attestation).
command -v gh >/dev/null 2>&1 || {
  echo "[pgserve] requires the 'gh' CLI for cosign attestation verification." >&2
  echo "[pgserve] install: https://cli.github.com/" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[pgserve] fetching $URL"
curl -fsSL --output "$TMP/$TARBALL" "$URL"

echo "[pgserve] verifying cosign attestation via gh"
gh attestation verify "$TMP/$TARBALL" --repo "$REPO"

echo "[pgserve] extracting"
tar -xzf "$TMP/$TARBALL" -C "$TMP"

# Tarball ships a `bin/pgserve` (or wrapper) at the root of the
# extracted dir. The release-publish workflow lays it out so that
# `pgserve install` Just Works after extract.
INSTALL_DIR="$HOME/.local/share/pgserve/${VERSION}"
mkdir -p "$INSTALL_DIR"
cp -r "$TMP"/* "$INSTALL_DIR/"

echo "[pgserve] installing pm2 supervisor"
"$INSTALL_DIR/bin/pgserve" install

echo "[pgserve] done — pgserve@${VERSION} installed under pm2"
