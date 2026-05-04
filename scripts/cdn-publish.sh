#!/usr/bin/env bash
#
# cdn-publish.sh — Group 9 of autopg-distribution-cutover.
#
# Pushes a *signed bundle* (Group 8 output) to the channel-keyed CDN
# layout consumed by install.sh + autopg update:
#
#   <base>/autopg/<channel>/<version>/manifest.json
#   <base>/autopg/<channel>/<version>/autopg-<version>-<platform>.tar.gz
#   <base>/autopg/<channel>/<version>/autopg-<version>-<platform>.tar.gz.sha256
#   <base>/autopg/<channel>/<version>/autopg-<version>-<platform>.tar.gz.sig
#   <base>/autopg/<channel>/<version>/autopg-<version>-<platform>.tar.gz.intoto.jsonl
#   <base>/autopg/<channel>/latest.json                  (atomic pointer)
#   <base>/autopg/keys/cosign.pub                        (when --publish-key)
#
# Two backends:
#
#   - s3     : production. Uses `aws s3 cp` + `aws s3api head-object`. Requires
#              AWS credentials in the environment. Sets cache-control headers
#              per distribution-exodus D7.
#
#   - local  : fixture / test. Uses cp + atomic mv. Records cache-control
#              hints next to each object in <file>.cache-control sidecars so
#              the integration test can assert without a real CDN.
#
# Cache-control policy (distribution-exodus D7):
#   versioned paths    : public, max-age=31536000, immutable
#   latest.json        : public, max-age=60, must-revalidate
#   keys/cosign.pub    : public, max-age=300, must-revalidate
#
# Immutability: a re-publish at the same channel+version is a hard FAIL.
# Pre-flight head-object on <channel>/<version>/manifest.json. Override
# with --allow-overwrite-versioned only for repair runs.
#
# Atomic latest.json: a single S3 PUT is atomic (object-level last-write-wins);
# we write the new pointer last so readers see the new version only after every
# tarball is in place. ETag matches content hash, so re-publishing identical
# pointer content does not bump ETag (success criterion S9-G9).
#
# Usage:
#   bash scripts/cdn-publish.sh \
#     --bundle dist/ \
#     --channel stable \
#     --version 2.260503.1 \
#     --backend s3 \
#     --bucket cdn.automagik.dev \
#     --base-prefix autopg \
#     [--publish-key] \
#     [--allow-overwrite-versioned] \
#     [--dry-run]
#
#   bash scripts/cdn-publish.sh \
#     --bundle /tmp/fixture-dist \
#     --channel stable \
#     --version 2.260503.1-fixture \
#     --backend local \
#     --target /tmp/cdn-fixture \
#     --publish-key
#
# Exit codes:
#   0  ok
#   1  IO / verify failure
#   2  invalid args / missing inputs
#   3  immutable re-publish blocked (override with --allow-overwrite-versioned)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------- defaults --------------------------------------------------------
BUNDLE_DIR=""
CHANNEL=""
VERSION=""
BACKEND=""
S3_BUCKET=""
LOCAL_TARGET=""
BASE_PREFIX="autopg"
PUBLISH_KEY=0
ALLOW_OVERWRITE=0
DRY_RUN=0
COSIGN_PUB_PATH="${REPO_ROOT}/keys/cosign.pub"

# Cache-control values (distribution-exodus D7).
CC_VERSIONED='public, max-age=31536000, immutable'
CC_LATEST='public, max-age=60, must-revalidate'
CC_KEY='public, max-age=300, must-revalidate'

# Counters for the summary line.
UPLOADED=0
SKIPPED=0
FAILED=0

# ---------- helpers ---------------------------------------------------------
log()   { printf '==> %s\n' "$*"; }
note()  { printf '    \xe2\x80\xa2 %s\n' "$*"; }
ok()    { printf '    \xe2\x9c\x93 %s\n' "$*"; UPLOADED=$((UPLOADED + 1)); }
skip()  { printf '    \xe2\x86\xb7 %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }
bad()   { printf '    \xe2\x9c\x97 %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }

usage() {
  cat <<EOF
Usage: $0 --bundle <dir> --channel <c> --version <v> --backend <s3|local> [...]

Required:
  --bundle <dir>          Group 8 signed bundle (contains tarballs + sigs +
                          intoto + manifest.json).
  --channel <c>           stable | beta | canary
  --version <v>           Version string (matches files in --bundle).
  --backend <s3|local>    s3 = production CDN (aws s3 cp); local = file-
                          based fixture.

Backend-specific:
  --bucket <name>         S3 bucket (e.g. cdn.automagik.dev). Required for
                          --backend s3.
  --target <dir>          Local target dir. Required for --backend local.
  --base-prefix <p>       Path prefix under bucket / target (default: autopg)

Optional:
  --publish-key           Also upload <repo>/keys/cosign.pub to keys/cosign.pub.
                          Default: false (cosign.pub is rotated out-of-band).
  --cosign-pub <path>     Override the public-key source path.
  --allow-overwrite-versioned
                          Allow re-publishing at an existing channel+version.
                          Default behaviour: hard fail (immutability).
  --dry-run               Print every action without uploading anything.
  -h / --help             Show this help.

Channels: stable, beta, canary
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bundle)        BUNDLE_DIR="$2";        shift 2 ;;
      --channel)       CHANNEL="$2";           shift 2 ;;
      --version)       VERSION="$2";           shift 2 ;;
      --backend)       BACKEND="$2";           shift 2 ;;
      --bucket)        S3_BUCKET="$2";         shift 2 ;;
      --target)        LOCAL_TARGET="$2";      shift 2 ;;
      --base-prefix)   BASE_PREFIX="$2";       shift 2 ;;
      --publish-key)   PUBLISH_KEY=1;          shift ;;
      --cosign-pub)    COSIGN_PUB_PATH="$2";   shift 2 ;;
      --allow-overwrite-versioned) ALLOW_OVERWRITE=1; shift ;;
      --dry-run)       DRY_RUN=1;              shift ;;
      -h|--help)       usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  [[ -n "$BUNDLE_DIR"  ]] || { echo "error: --bundle required"  >&2; exit 2; }
  [[ -n "$CHANNEL"     ]] || { echo "error: --channel required" >&2; exit 2; }
  [[ -n "$VERSION"     ]] || { echo "error: --version required" >&2; exit 2; }
  [[ -n "$BACKEND"     ]] || { echo "error: --backend required" >&2; exit 2; }

  case "$CHANNEL" in
    stable|beta|canary) ;;
    *) echo "error: --channel must be stable|beta|canary (got: $CHANNEL)" >&2; exit 2 ;;
  esac

  case "$BACKEND" in
    s3)
      [[ -n "$S3_BUCKET" ]] || { echo "error: --bucket required for --backend s3" >&2; exit 2; }
      ;;
    local)
      [[ -n "$LOCAL_TARGET" ]] || { echo "error: --target required for --backend local" >&2; exit 2; }
      ;;
    *) echo "error: --backend must be s3|local (got: $BACKEND)" >&2; exit 2 ;;
  esac

  [[ -d "$BUNDLE_DIR" ]] || { echo "error: bundle dir not found: $BUNDLE_DIR" >&2; exit 2; }

  if [[ "$PUBLISH_KEY" -eq 1 && ! -f "$COSIGN_PUB_PATH" ]]; then
    echo "error: --publish-key set but cosign.pub not found at $COSIGN_PUB_PATH" >&2
    exit 2
  fi
}

require_tools() {
  if [[ "$BACKEND" == "s3" && "$DRY_RUN" -eq 0 ]]; then
    command -v aws >/dev/null 2>&1 || {
      echo "error: aws CLI not on PATH (https://aws.amazon.com/cli/)" >&2
      exit 2
    }
  fi
}

# ---------- key derivation --------------------------------------------------
# Strip leading slashes from a path component to keep S3 keys clean.
join_key() {
  local out=""
  local part
  for part in "$@"; do
    part="${part#/}"
    part="${part%/}"
    [[ -z "$part" ]] && continue
    if [[ -z "$out" ]]; then out="$part"; else out="$out/$part"; fi
  done
  printf '%s' "$out"
}

versioned_key()  { join_key "$BASE_PREFIX" "$CHANNEL" "$VERSION" "$1"; }
channel_key()    { join_key "$BASE_PREFIX" "$CHANNEL" "$1"; }
top_key()        { join_key "$BASE_PREFIX" "$1"; }

# ---------- backend dispatch ------------------------------------------------
# upload_object <local-file> <key> <cache-control>
upload_object() {
  local src="$1" key="$2" cc="$3"
  if [[ ! -f "$src" ]]; then bad "missing source: $src"; return 1; fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    note "DRY-RUN upload  ${src} -> ${key}  (cache-control: ${cc})"
    UPLOADED=$((UPLOADED + 1))
    return 0
  fi

  case "$BACKEND" in
    s3)    s3_upload    "$src" "$key" "$cc" ;;
    local) local_upload "$src" "$key" "$cc" ;;
  esac
}

# object_exists <key> -> 0 if exists, 1 otherwise
object_exists() {
  local key="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then return 1; fi
  case "$BACKEND" in
    s3)    s3_object_exists    "$key" ;;
    local) local_object_exists "$key" ;;
  esac
}

# ---------- s3 backend ------------------------------------------------------
s3_upload() {
  local src="$1" key="$2" cc="$3"
  local content_type
  content_type=$(content_type_for "$src")
  if aws s3 cp "$src" "s3://${S3_BUCKET}/${key}" \
       --cache-control "$cc" \
       --content-type "$content_type" \
       --no-progress >/dev/null 2>&1; then
    ok "s3://${S3_BUCKET}/${key}  (cc: ${cc})"
  else
    bad "FAILED s3://${S3_BUCKET}/${key}"
    return 1
  fi
}

s3_object_exists() {
  local key="$1"
  if aws s3api head-object --bucket "$S3_BUCKET" --key "$key" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# ---------- local backend ---------------------------------------------------
local_upload() {
  local src="$1" key="$2" cc="$3"
  local dest="${LOCAL_TARGET}/${key}"
  local destdir
  destdir="$(dirname "$dest")"
  mkdir -p "$destdir"

  # Atomic write: copy to <dest>.partial then rename.
  cp "$src" "${dest}.partial"
  mv -f "${dest}.partial" "$dest"

  # Record cache-control + content-type as sidecars so the smoke test
  # can validate the policy without a real HTTP origin.
  printf '%s\n' "$cc"                        > "${dest}.cache-control"
  printf '%s\n' "$(content_type_for "$src")" > "${dest}.content-type"

  ok "${LOCAL_TARGET}/${key}  (cc: ${cc})"
}

local_object_exists() {
  [[ -e "${LOCAL_TARGET}/$1" ]]
}

# ---------- content-type sniff ---------------------------------------------
content_type_for() {
  case "$1" in
    *.tar.gz)        printf 'application/gzip' ;;
    *.json)          printf 'application/json' ;;
    *.sig|*.sha256)  printf 'text/plain; charset=utf-8' ;;
    *.intoto.jsonl)  printf 'application/vnd.in-toto+json' ;;
    *.pub)           printf 'application/x-pem-file' ;;
    *)               printf 'application/octet-stream' ;;
  esac
}

# ---------- pre-flight ------------------------------------------------------
preflight_immutability() {
  local probe
  probe="$(versioned_key 'manifest.json')"

  if object_exists "$probe"; then
    if [[ "$ALLOW_OVERWRITE" -eq 1 ]]; then
      note "EXISTS at ${probe} — re-publish allowed (--allow-overwrite-versioned)"
      return 0
    fi
    echo "::error::Versioned URL already exists: ${probe}" >&2
    echo "::error::Refusing to overwrite (immutable contract). Pass --allow-overwrite-versioned only for repair runs." >&2
    exit 3
  fi
  note "channel=${CHANNEL} version=${VERSION} not yet present (immutability OK)"
}

# ---------- bundle inventory ------------------------------------------------
discover_bundle() {
  TARBALLS=()
  while IFS= read -r line; do
    TARBALLS+=("$line")
  done < <(find "$BUNDLE_DIR" -maxdepth 1 -name "autopg-${VERSION}-*.tar.gz" -type f | LC_ALL=C sort)

  if [[ ${#TARBALLS[@]} -eq 0 ]]; then
    echo "error: no autopg-${VERSION}-*.tar.gz files in ${BUNDLE_DIR}" >&2
    exit 2
  fi

  for t in "${TARBALLS[@]}"; do
    for ext in sha256 sig intoto.jsonl; do
      if [[ ! -f "${t}.${ext}" ]]; then
        echo "error: missing sibling ${t}.${ext} (run sign-attest first)" >&2
        exit 2
      fi
    done
  done

  if [[ ! -f "${BUNDLE_DIR}/manifest.json" ]]; then
    echo "error: ${BUNDLE_DIR}/manifest.json missing (run aggregate-manifest first)" >&2
    exit 2
  fi
}

# ---------- latest.json builder --------------------------------------------
# Builds the channel pointer doc atomically, points at the just-published
# version directory. Conservative shape (no platforms array — install.sh
# resolves the platform by walking down to <version>/manifest.json).
emit_latest_json() {
  local out="$1"
  local generated_at
  generated_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "$out" <<EOF
{
  "name": "autopg",
  "channel": "${CHANNEL}",
  "version": "${VERSION}",
  "schemaVersion": 1,
  "generated_at": "${generated_at}",
  "manifest_path": "${VERSION}/manifest.json"
}
EOF
}

# ---------- main publish ----------------------------------------------------
publish_bundle() {
  log "publish bundle: ${BUNDLE_DIR}"
  log "  backend   : ${BACKEND}"
  log "  channel   : ${CHANNEL}"
  log "  version   : ${VERSION}"
  if [[ "$BACKEND" == "s3" ]]; then
    log "  bucket    : ${S3_BUCKET}"
  else
    log "  target    : ${LOCAL_TARGET}"
  fi
  log "  dry-run   : ${DRY_RUN}"

  preflight_immutability

  log "uploading versioned artifacts (cache: immutable, 1y)"
  for tarball in "${TARBALLS[@]}"; do
    local base
    base="$(basename "$tarball")"
    upload_object "$tarball"               "$(versioned_key "$base")"               "$CC_VERSIONED"
    upload_object "${tarball}.sha256"      "$(versioned_key "${base}.sha256")"      "$CC_VERSIONED"
    upload_object "${tarball}.sig"         "$(versioned_key "${base}.sig")"         "$CC_VERSIONED"
    upload_object "${tarball}.intoto.jsonl" "$(versioned_key "${base}.intoto.jsonl")" "$CC_VERSIONED"
  done

  upload_object "${BUNDLE_DIR}/manifest.json" "$(versioned_key 'manifest.json')" "$CC_VERSIONED"

  log "writing channel pointer (cache: 60s, must-revalidate)"
  local tmp_latest
  tmp_latest="$(mktemp -t autopg-latest.json.XXXXXX)"
  trap 'rm -f "$tmp_latest"' RETURN
  emit_latest_json "$tmp_latest"
  upload_object "$tmp_latest" "$(channel_key 'latest.json')" "$CC_LATEST"
  rm -f "$tmp_latest"
  trap - RETURN

  if [[ "$PUBLISH_KEY" -eq 1 ]]; then
    log "publishing cosign.pub (cache: 5m, must-revalidate)"
    upload_object "$COSIGN_PUB_PATH" "$(top_key 'keys/cosign.pub')" "$CC_KEY"
  else
    note "skipping cosign.pub (pass --publish-key to upload)"
  fi
}

main() {
  parse_args "$@"
  require_tools
  discover_bundle
  publish_bundle

  echo
  log "result: uploaded=${UPLOADED} skipped=${SKIPPED} failed=${FAILED}"
  if [[ "$FAILED" -gt 0 ]]; then
    echo "::error::cdn-publish: ${FAILED} object(s) failed to upload" >&2
    exit 1
  fi
}

main "$@"
