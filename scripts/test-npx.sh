#!/bin/bash
# Test that the package works with npx (simulates fresh user install)
# This catches path resolution issues that static analysis can't detect.
#
# v2.4 contract change (2026-05-08): `pgserve` (no args) now prints help and
# exits cleanly. The long-running entry is `pgserve postmaster` (or its
# `pgserve serve` alias). This test invokes the postmaster directly to verify
# npx-installed bits boot a real PG.

set -e

echo "=== Testing npx compatibility (v2.4 postmaster entry) ==="

# Create temp directory
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

# Pack the current package
echo "Packing package..."
PACK_OUTPUT=$(npm pack --pack-destination "$TEST_DIR" 2>&1)
PACK_FILE=$(echo "$PACK_OUTPUT" | grep -E '\.tgz$' | tail -1)

# If npm pack fails, exit with an error
if [ -z "$PACK_FILE" ] || [ ! -f "$TEST_DIR/$PACK_FILE" ]; then
  echo "✗ Failed to pack package with npm"
  echo "Pack output: $PACK_OUTPUT"
  exit 1
fi
echo "Packed: $PACK_FILE"

# Install in isolated environment using npm
echo "Installing in isolated environment..."
cd "$TEST_DIR"
echo '{"name":"test-npx-install","private":true}' > package.json
npm install "./$PACK_FILE" > /dev/null 2>&1

# Verify the bare invocation prints v2.4 help and exits 0 (regression guard
# for the breaking-cut: pre-v2.4 auto-started a server here).
echo "Verifying bare 'npx pgserve' prints v2.4 help and exits cleanly..."
HELP_OUT=$(npx pgserve 2>&1)
if ! echo "$HELP_OUT" | grep -q "pgserve postmaster"; then
  echo "✗ Bare 'npx pgserve' output does not match v2.4 help (missing 'pgserve postmaster')"
  echo "Output:"
  echo "$HELP_OUT"
  echo "=== npx test FAILED ==="
  exit 1
fi
echo "✓ Bare invocation prints v2.4 help"

# Test that the postmaster entry starts (with timeout)
DATA_DIR="$TEST_DIR/data"
SOCKET_DIR="$TEST_DIR/sock"
mkdir -p "$DATA_DIR" "$SOCKET_DIR"
echo "Testing postmaster startup via npx (port 15432)..."
timeout 30 npx pgserve postmaster --port 15432 --data "$DATA_DIR" --socket-dir "$SOCKET_DIR" > output.log 2>&1 &
PID=$!

# Wait for ready signal — bin/postgres-server.js logs
# 'pgserve postmaster: ready (Unix socket + TCP)' once both transports are bound.
for i in {1..60}; do
  if grep -q "pgserve postmaster: ready" output.log 2>/dev/null; then
    echo "✓ Postmaster started successfully via npx"
    kill $PID 2>/dev/null || true
    wait $PID 2>/dev/null || true
    echo "=== npx test PASSED ==="
    exit 0
  fi
  if ! kill -0 $PID 2>/dev/null; then
    echo "✗ Postmaster exited unexpectedly"
    cat output.log
    echo "=== npx test FAILED ==="
    exit 1
  fi
  sleep 0.5
done

# Timeout
kill $PID 2>/dev/null || true
echo "✗ Postmaster did not start within timeout"
cat output.log
echo "=== npx test FAILED ==="
exit 1
