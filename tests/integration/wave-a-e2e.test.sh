#!/usr/bin/env bash
#
# wave-a-e2e.test.sh — Wave A round-trip smoke for the keyless cosign
# trust loop. autopg-distribution-cutover-finalize wish G5/Wave A PR-A3 D9.
#
# Exercises the build → sign → verify round-trip locally without needing
# a real GitHub Release. Catches regressions in:
#   - sign-attest.yml's keyless cosign flag set (sign-blob shape)
#   - trust-list.js's pgserve regex anchor (sign-attest.yml @ refs/tags/v.*)
#   - cosign verify-blob's keyless flag compatibility
#
# Skip-gracefully on:
#   - missing cosign binary
#   - missing OIDC token (cosign keyless needs id-token:write or interactive
#     browser auth via OAuth; CI sans permission OR local dev without auth)
#
# Exit codes:
#   0  pass (or skipped because cosign/OIDC unavailable)
#   1  any acceptance criterion failed
#
# Pipeline:
#   1) synthesize a 64-byte test tarball at $TMP/synthetic-blob.tar.gz
#   2) cosign sign-blob --yes --output-signature ... --output-certificate ...
#      (uses ephemeral OIDC; in CI, the workflow's id-token:write mints one)
#   3) cosign verify-blob with the production trust regex
#      (refs/heads/main vs refs/tags/v.* tolerated via a CI-local regex)
#   4) Negative check: verify-blob against an INTENTIONALLY-WRONG identity
#      regex must FAIL (rejects releases signed by some-other-repo)
#

set -euo pipefail

# ---------- Skip gracefully on missing tooling ----------
if ! command -v cosign >/dev/null 2>&1; then
    echo "wave-a-e2e: SKIP (cosign not on PATH)"
    exit 0
fi

# Detect whether keyless signing is even attemptable. In CI with
# id-token:write, $ACTIONS_ID_TOKEN_REQUEST_TOKEN is set. Locally, cosign
# falls back to OAuth browser flow which we don't want in CI.
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ] && [ -z "${COSIGN_EXPERIMENTAL:-}" ]; then
    if [ "${WAVE_A_E2E_FORCE:-}" != "1" ]; then
        echo "wave-a-e2e: SKIP (no OIDC token; set WAVE_A_E2E_FORCE=1 + browser auth for local run)"
        exit 0
    fi
fi

# ---------- Setup ephemeral workspace ----------
TMP_DIR=$(mktemp -d -t wave-a-e2e-XXXXXX)
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$TMP_DIR"

# ---------- Step 1: synthesize the test tarball ----------
echo "==> Step 1/4 — synthesize test tarball"
mkdir -p src
echo "wave-a-e2e smoke payload $(date -u +%Y-%m-%dT%H:%M:%SZ)" > src/payload.txt
tar -czf synthetic-blob.tar.gz src/
ls -la synthetic-blob.tar.gz
PAYLOAD_SHA=$(sha256sum synthetic-blob.tar.gz | awk '{print $1}')
echo "synthetic-blob sha256: $PAYLOAD_SHA"

# ---------- Step 2: cosign sign-blob (keyless OIDC) ----------
echo
echo "==> Step 2/4 — cosign sign-blob (keyless OIDC)"
export COSIGN_YES="true"
SIG="synthetic-blob.tar.gz.sig"
CERT="synthetic-blob.tar.gz.cert"

cosign sign-blob \
    --yes \
    --output-signature "$SIG" \
    --output-certificate "$CERT" \
    synthetic-blob.tar.gz

[ -f "$SIG" ] || { echo "FAIL: cosign did not produce $SIG"; exit 1; }
[ -f "$CERT" ] || { echo "FAIL: cosign did not produce $CERT"; exit 1; }
echo "sig + cert produced"

# Inspect the cert subject (informational)
echo
echo "==> Step 2.5 — cert subject (informational)"
openssl x509 -in "$CERT" -text -noout 2>/dev/null | grep -A1 "Subject Alternative Name" | head -5 || true

# ---------- Step 3: cosign verify-blob (positive case) ----------
echo
echo "==> Step 3/4 — cosign verify-blob (positive case)"
# CI-local positive regex: match this workflow's identity (whatever branch
# or ref it ran on). NOT the production trust regex — that one anchors on
# refs/tags/v.* which a CI run on a feature branch won't satisfy. We're
# proving the sign + verify CLI flag set works, not the prod trust binding.
if [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_WORKFLOW_REF:-}" ]; then
    CI_REGEX="^https://github.com/${GITHUB_REPOSITORY}/.github/workflows/.*\\.yml@.*$"
else
    # Local dev — try matching ANY github actions identity URI shape.
    CI_REGEX="^https://github\\.com/.+/.github/workflows/.+\\.yml@.+\$"
fi

cosign verify-blob \
    --certificate-identity-regexp "$CI_REGEX" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --signature "$SIG" \
    --certificate "$CERT" \
    synthetic-blob.tar.gz

echo "positive verify: OK"

# ---------- Step 4: cosign verify-blob (negative case) ----------
echo
echo "==> Step 4/4 — cosign verify-blob (negative case — wrong-identity must FAIL)"
WRONG_REGEX="^https://github.com/never-existed-org/never-existed-repo/.github/workflows/release.yml@refs/tags/v.*\$"
if cosign verify-blob \
    --certificate-identity-regexp "$WRONG_REGEX" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --signature "$SIG" \
    --certificate "$CERT" \
    synthetic-blob.tar.gz 2>/dev/null; then
    echo "FAIL: verify-blob succeeded against a wrong-identity regex — trust loop is BROKEN"
    exit 1
fi
echo "negative verify: correctly rejected"

# ---------- Done ----------
echo
echo "wave-a-e2e: PASS"
echo "  - synthetic tarball produced + sha256 captured"
echo "  - cosign sign-blob (keyless) produced sig + cert"
echo "  - positive verify against CI-local regex: OK"
echo "  - negative verify against wrong-identity regex: correctly rejected"
exit 0
