#!/bin/bash
# Test that the package works with bunx (simulates fresh install)
# This catches path resolution issues that static analysis can't detect

set -e

echo "=== Testing bunx compatibility ==="

# Create temp directory
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

# Pack the current package
echo "Packing package..."
PACK_FILE=$(bun pm pack --destination "$TEST_DIR" 2>/dev/null | grep -o '[^ ]*\.tgz' | head -1)

# If bun pm pack fails, exit with an error
if [ -z "$PACK_FILE" ] || [ ! -f "$TEST_DIR/$PACK_FILE" ]; then
  echo "✗ Failed to pack package with bun"
  exit 1
fi

# Extract and install in isolated environment
echo "Installing in isolated environment..."
cd "$TEST_DIR"
echo '{"name":"test","type":"module"}' > package.json
bun add "./$PACK_FILE" > /dev/null 2>&1 || bun install "$PACK_FILE" > /dev/null 2>&1

# Test that it starts (with timeout)
echo "Testing server startup..."
timeout 8 bunx pgserve --no-cluster --port 15432 > output.log 2>&1 &
PID=$!

# Wait for ready signal
for i in {1..20}; do
  if grep -q "READY" output.log 2>/dev/null; then
    echo "✓ Server started successfully"
    kill $PID 2>/dev/null || true
    wait $PID 2>/dev/null || true
    echo "=== bunx test PASSED ==="
    exit 0
  fi
  if ! kill -0 $PID 2>/dev/null; then
    echo "✗ Server exited unexpectedly"
    cat output.log
    echo "=== bunx test FAILED ==="
    exit 1
  fi
  sleep 0.5
done

# Timeout
kill $PID 2>/dev/null || true
echo "✗ Server did not start within timeout"
cat output.log
echo "=== bunx test FAILED ==="
exit 1
