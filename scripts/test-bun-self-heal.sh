#!/bin/bash
# Regression test for https://github.com/namastexlabs/pgserve/issues/22
#
# When pgserve is installed via `bun install`, the nested `bun` npm package's
# postinstall can be skipped, leaving @oven/bun-<platform>/bin/bun empty.
# The bun stub then refuses to run with "Bun's postinstall script was not run".
# pgserve-wrapper.cjs must detect this and self-heal via `node install.js`.
#
# This test stages a synthetic broken install tree, runs the wrapper, and
# asserts that it recovers and spawns postgres-server.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$REPO_ROOT/bin/pgserve-wrapper.cjs"

if [ ! -f "$WRAPPER" ]; then
  echo "✗ wrapper not found: $WRAPPER"
  exit 1
fi

# Use a real bun binary as the "recovered" payload so the healthy-path
# assertion is meaningful. Falls back to any bun on PATH.
REAL_BUN="${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$REAL_BUN" ] || [ ! -x "$REAL_BUN" ]; then
  echo "✗ bun runtime not found on PATH (set BUN_BIN to override)"
  exit 1
fi

FIXTURE=$(mktemp -d)
trap "rm -rf $FIXTURE" EXIT

mkdir -p "$FIXTURE/node_modules/bun/bin"
mkdir -p "$FIXTURE/node_modules/@oven/bun-linux-x64/bin"   # empty, simulating the bug
mkdir -p "$FIXTURE/node_modules/.bin"
mkdir -p "$FIXTURE/node_modules/pgserve/bin"

cp "$WRAPPER" "$FIXTURE/node_modules/pgserve/bin/pgserve-wrapper.cjs"

# Stub postgres-server so we can detect a successful spawn without needing
# postgres binaries in the fixture.
cat > "$FIXTURE/node_modules/pgserve/bin/postgres-server.js" <<'EOF'
console.log("postgres-server-spawned");
process.exit(0);
EOF

# Fake bun install.js: copies the real bun into the expected @oven location,
# mirroring what the real postinstall does.
cat > "$FIXTURE/node_modules/bun/install.js" <<EOF
const fs = require('fs');
const path = require('path');
const dst = path.resolve(__dirname, '..', '@oven', 'bun-linux-x64', 'bin', 'bun');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync('$REAL_BUN', dst);
fs.chmodSync(dst, 0o755);
console.log('[test] install.js populated', dst);
EOF
echo '{"name":"bun","version":"1.3.12"}' > "$FIXTURE/node_modules/bun/package.json"

# Broken bun stub: prints the postinstall error unless the @oven binary exists.
cat > "$FIXTURE/node_modules/bun/bin/bun" <<'EOF'
#!/bin/sh
SELF=$(readlink -f "$0")
TARGET="$(dirname "$SELF")/../../@oven/bun-linux-x64/bin/bun"
if [ ! -x "$TARGET" ]; then
  echo "Error: Bun's postinstall script was not run." >&2
  echo "" >&2
  echo "To fix this, run the postinstall script manually:" >&2
  echo "  cd node_modules/bun && node install.js" >&2
  exit 1
fi
exec "$TARGET" "$@"
EOF
chmod +x "$FIXTURE/node_modules/bun/bin/bun"

ln -s ../bun/bin/bun "$FIXTURE/node_modules/.bin/bun"

echo "=== Testing self-heal on broken install ==="
OUTPUT=$(node "$FIXTURE/node_modules/pgserve/bin/pgserve-wrapper.cjs" 2>&1)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "✗ wrapper exited non-zero: $EXIT"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "attempting self-heal"; then
  echo "✗ wrapper did not attempt self-heal"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "bun runtime recovered"; then
  echo "✗ wrapper did not report recovery"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "postgres-server-spawned"; then
  echo "✗ postgres-server was not spawned after self-heal"
  echo "$OUTPUT"
  exit 1
fi

echo "✓ self-heal path: wrapper detected, repaired, and spawned postgres-server"

echo ""
echo "=== Testing healthy path is unaffected ==="
OUTPUT=$(node "$FIXTURE/node_modules/pgserve/bin/pgserve-wrapper.cjs" 2>&1)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "✗ wrapper exited non-zero on healthy path: $EXIT"
  echo "$OUTPUT"
  exit 1
fi

if echo "$OUTPUT" | grep -q "self-heal\|recovered"; then
  echo "✗ wrapper logged self-heal messages on a healthy install"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "postgres-server-spawned"; then
  echo "✗ postgres-server was not spawned on healthy path"
  echo "$OUTPUT"
  exit 1
fi

echo "✓ healthy path: wrapper was silent and spawned postgres-server directly"

echo ""
echo "=== Testing non-postinstall errors surface raw ==="
# Replace stub with one that emits an unrelated error.
cat > "$FIXTURE/node_modules/bun/bin/bun" <<'EOF'
#!/bin/sh
echo "Error: GLIBC_2.99 not found (libc mismatch)" >&2
exit 127
EOF
chmod +x "$FIXTURE/node_modules/bun/bin/bun"

# Clear the @oven healed binary so the stub is what runs.
rm -f "$FIXTURE/node_modules/@oven/bun-linux-x64/bin/bun"

OUTPUT=$(node "$FIXTURE/node_modules/pgserve/bin/pgserve-wrapper.cjs" 2>&1 || true)

if echo "$OUTPUT" | grep -q "self-heal"; then
  echo "✗ wrapper tried self-heal for a non-postinstall error"
  echo "$OUTPUT"
  exit 1
fi

if ! echo "$OUTPUT" | grep -q "GLIBC_2.99"; then
  echo "✗ wrapper did not surface the real error message"
  echo "$OUTPUT"
  exit 1
fi

echo "✓ unrelated-error path: wrapper surfaced the raw error without self-heal"

echo ""
echo "=== bun self-heal test PASSED ==="
