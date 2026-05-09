#!/usr/bin/env bash
# install.sh shim — DEPRECATED in v2.6.
#
# Renamed to install-autopg.sh as part of the autopg distribution
# cutover (`.genie/wishes/autopg-distribution-cutover-finalize` G1).
# This shim exists so operators with bookmarked `curl … | sh`
# invocations get a clear hint instead of a silent break.
#
# Exits 0 (intentionally) so existing automation isn't hard-broken.
echo "[pgserve] install.sh is deprecated; use install-autopg.sh going forward." >&2
echo "[pgserve] migration: curl -fsSL https://raw.githubusercontent.com/namastexlabs/pgserve/main/install-autopg.sh | bash" >&2
echo "[pgserve] (npm-based legacy installer is preserved at install-pgserve-legacy.sh if you need it)." >&2
exit 0
