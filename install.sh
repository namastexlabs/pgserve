#!/usr/bin/env bash
# autopg installer (Group 10 / autopg-distribution-cutover) — bootstrap, verify, hand off.
set -euo pipefail
CHANNEL="${AUTOPG_CHANNEL:-stable}"
CDN_BASE="${AUTOPG_CDN_BASE:-https://cdn.automagik.dev/autopg}"
INSTALL_ROOT="${HOME}/.autopg/install"
COSIGN_PUB="${HOME}/.autopg/cosign.pub"
TMP=""
cleanup() { [[ -n "${TMP:-}" && -d "${TMP}" ]] && rm -rf "${TMP}"; }; trap cleanup EXIT
die()  { printf 'autopg-install: %s\n' "$*" >&2; exit 1; }
log()  { printf 'autopg-install: %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux|Darwin) : ;;
  MINGW*|MSYS*|CYGWIN*) die 'Windows native is not supported. Use WSL: see https://docs.automagik.dev/autopg/wsl' ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
fetch() {
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1" || die "fetch failed: $1"
  elif have wget; then wget -q -O "$2" "$1" || die "fetch failed: $1"
  else die 'curl or wget required'; fi
}
ensure_bun() {
  have bun && return 0
  log 'installing bun'; fetch 'https://bun.sh/install' "${TMP}/bun.sh"
  bash "${TMP}/bun.sh" >/dev/null || die 'bun install failed'
  export PATH="${HOME}/.bun/bin:${PATH}"
  have bun || die 'bun installed but not on PATH'
}
ensure_pm2() {
  have pm2 && return 0
  log 'installing pm2'; bun add -g pm2 >/dev/null || die 'pm2 install failed'
  have pm2 || die 'pm2 installed but not on PATH'
}
detect_platform() {
  local m; m="$(uname -m)"
  case "$(uname -s)__${m}" in
    Darwin__x86_64) echo darwin-x64 ;;
    Darwin__arm64|Darwin__aarch64) echo darwin-arm64 ;;
    Linux__x86_64) if ldd --version 2>&1 | grep -qi musl; then echo linux-x64-musl; else echo linux-x64-glibc; fi ;;
    Linux__aarch64|Linux__arm64) echo linux-arm64 ;;
    *) die "unsupported platform: $(uname -s) ${m}" ;;
  esac
}
jget()   { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n1; }
absify() { case "$1" in http*) printf '%s' "$1" ;; *) printf '%s/%s' "$2" "$1" ;; esac; }
sha_ok() { local a; a="$( { sha256sum "$2" 2>/dev/null || shasum -a 256 "$2" 2>/dev/null; } | awk '{print $1}')"; [[ "$a" == "$1" ]]; }
main() {
  TMP="$(mktemp -d -t autopg-install.XXXXXX)"
  ensure_bun; ensure_pm2
  local platform version mpath block url sha sig prov base tarball dest
  platform="$(detect_platform)"
  log "channel=${CHANNEL} platform=${platform}"
  fetch "${CDN_BASE}/${CHANNEL}/latest.json" "${TMP}/latest.json"
  version="$(jget "${TMP}/latest.json" version)"; mpath="$(jget "${TMP}/latest.json" manifest_path)"
  [[ -n "$version" && -n "$mpath" ]] || die 'malformed latest.json'
  fetch "${CDN_BASE}/${CHANNEL}/${mpath}" "${TMP}/manifest.json"
  block="$(awk -v p="\"platform\": \"${platform}\"" 'BEGIN{RS="}"} $0~p{print; exit}' "${TMP}/manifest.json")"
  [[ -n "$block" ]] || die "no manifest entry for platform ${platform}"
  url="$(printf  '%s' "$block" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  sha="$(printf  '%s' "$block" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  sig="$(printf  '%s' "$block" | sed -n 's/.*"signature_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  prov="$(printf '%s' "$block" | sed -n 's/.*"provenance_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -n "$url" && -n "$sha" && -n "$sig" && -n "$prov" ]] || die 'manifest entry missing required fields'
  base="${CDN_BASE}/${CHANNEL}/${mpath%/*}"
  url="$(absify "$url" "$base")"; sig="$(absify "$sig" "$base")"; prov="$(absify "$prov" "$base")"
  tarball="${TMP}/$(basename "$url")"
  fetch "$url" "$tarball"; fetch "$sig" "${tarball}.sig"; fetch "$prov" "${tarball}.intoto.jsonl"
  sha_ok "$sha" "$tarball" || die "sha256 mismatch: ${tarball}"
  mkdir -p "$(dirname "$COSIGN_PUB")"; fetch "${CDN_BASE}/keys/cosign.pub" "$COSIGN_PUB"
  if have cosign; then cosign verify-blob --key "$COSIGN_PUB" --signature "${tarball}.sig" "$tarball" >/dev/null || die 'cosign verify failed'
  else log 'cosign missing — skipping signature verify (install cosign for S8 coverage)'; fi
  if have slsa-verifier; then slsa-verifier verify-artifact "$tarball" --provenance-path "${tarball}.intoto.jsonl" --source-uri github.com/automagik-dev/autopg >/dev/null || die 'slsa-verifier failed'
  else log 'slsa-verifier missing — skipping provenance verify'; fi
  dest="${INSTALL_ROOT}/${version}"; mkdir -p "$dest"; tar -xzf "$tarball" -C "$dest"
  log "installed ${version} to ${dest}; handing off to autopg install"
  exec "${dest}/autopg/autopg" install --non-interactive
}
main "$@"
