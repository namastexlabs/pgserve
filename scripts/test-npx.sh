#!/bin/bash
# Test that the package works with npx (simulates fresh user install)
# This catches path resolution issues that static analysis can't detect

set -e

echo "=== Testing npx compatibility ==="

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

# Test that it starts (with timeout)
echo "Testing server startup via npx..."
timeout 30 npx pgserve --no-cluster --port 15432 > output.log 2>&1 &
PID=$!

# Wait for ready signal (Server started successfully!)
for i in {1..60}; do
  if grep -q "Server started successfully" output.log 2>/dev/null; then
    echo "✓ Server started successfully via npx"
    kill $PID 2>/dev/null || true
    wait $PID 2>/dev/null || true
    echo "=== npx test PASSED ==="
    exit 0
  fi
  if ! kill -0 $PID 2>/dev/null; then
    echo "✗ Server exited unexpectedly"
    cat output.log
    echo "=== npx test FAILED ==="
    exit 1
  fi
  sleep 0.5
done

# Timeout
kill $PID 2>/dev/null || true
echo "✗ Server did not start within timeout"
cat output.log
echo "=== npx test FAILED ==="
exit 1
