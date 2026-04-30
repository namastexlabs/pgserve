#!/usr/bin/env bash
# ============================================================================
# pgserve — Canonical PostgreSQL backbone installer
#
# Bootstraps a single shared pgserve instance under pm2 supervision. Used as
# a prerequisite by `omni/install.sh` and `genie/install.sh` so every
# automagik service on a host points at the same Postgres.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/namastexlabs/pgserve/main/install.sh | bash
#
# With pinned version:
#   PGSERVE_VERSION=^2.1.1 curl -fsSL .../install.sh | bash
#
# Local checkout:
#   bash install.sh
#
# Idempotent — re-running is a no-op success when pgserve is already
# registered under pm2 with a healthy entry.
# ============================================================================
set -euo pipefail

PGSERVE_VERSION="${PGSERVE_VERSION:-^2.1.0}"

# Colors (no-op when stdout isn't a tty)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' NC=''
fi

info() { printf "${BLUE}ℹ${NC}  %s\n" "$*"; }
ok()   { printf "${GREEN}✓${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
fail() { printf "${RED}✗${NC}  %s\n" "$*" >&2; exit 1; }
step() { printf "\n${BOLD}${CYAN}▸ %s${NC}\n" "$*"; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

# ============================================================================
# Prerequisites: bun + pm2
# ============================================================================

ensure_bun() {
  if has_cmd bun; then
    ok "bun $(bun --version 2>/dev/null || echo '?')"
    return 0
  fi
  info "Installing bun (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || fail "bun install failed — see https://bun.sh"
  # Make bun available to the rest of this script without requiring a re-login.
  export PATH="$HOME/.bun/bin:$PATH"
  has_cmd bun || fail "bun installed but not on PATH — restart your shell and re-run."
  ok "bun $(bun --version)"
}

ensure_pm2() {
  if has_cmd pm2; then
    ok "pm2 $(pm2 --version 2>/dev/null || echo '?')"
    return 0
  fi
  info "Installing pm2 (process supervisor)..."
  bun add -g pm2 >/dev/null 2>&1 || fail "pm2 install failed — try: bun add -g pm2"
  has_cmd pm2 || fail "pm2 installed but not on PATH — restart your shell and re-run."
  ok "pm2 installed"
}

# ============================================================================
# pgserve binary + pm2 registration
# ============================================================================

ensure_pgserve_binary() {
  # Probe via `pgserve port` (real subcommand). `pgserve --version` doesn't
  # exist in 2.1.x — using it would false-negative and trigger a redundant
  # reinstall every time install.sh runs.
  if has_cmd pgserve && pgserve port >/dev/null 2>&1; then
    ok "pgserve binary present (port $(pgserve port 2>/dev/null))"
    return 0
  fi
  info "Installing pgserve@${PGSERVE_VERSION} globally..."
  bun add -g "pgserve@${PGSERVE_VERSION}" >/dev/null 2>&1 \
    || fail "pgserve install failed — try: bun add -g pgserve@${PGSERVE_VERSION}"
  has_cmd pgserve || fail "pgserve installed but not on PATH — restart your shell and re-run."
  ok "pgserve $(pgserve port 2>/dev/null || echo '?')"
}

register_pgserve_pm2() {
  info "Registering pgserve under pm2 (idempotent)..."
  # `pgserve install` prints its own success/already-installed line and exits
  # 0 in both cases. We pipe stderr through so any pm2 errors surface to the
  # operator (the pm2-6.x --min-uptime breakage we hit on 2026-04-30 was
  # invisible because stderr was being captured).
  pgserve install || fail "pgserve install failed — see ~/.pgserve/logs/pgserve-error.log"
}

# ============================================================================
# Main
# ============================================================================

main() {
  step "Installing canonical pgserve"
  ensure_bun
  ensure_pm2
  ensure_pgserve_binary
  register_pgserve_pm2

  echo ""
  ok "Canonical pgserve ready"
  info "URL:  $(pgserve url 2>/dev/null || echo '<run: pgserve url>')"
  info "Port: $(pgserve port 2>/dev/null || echo '?')"
  info "Logs: ~/.pgserve/logs/"
  echo ""
  info "Other automagik services on this host (omni, genie, ...) will share this pgserve."
  echo ""
}

main "$@"
