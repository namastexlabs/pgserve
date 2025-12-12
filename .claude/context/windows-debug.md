# Windows Debug Context

## RESOLVED (2025-12-12)

The Windows router binding issue has been fixed. See "Solution Applied" below.

---

## Original Issue
PostgreSQL starts successfully on port 9432, but the router/proxy on port 8432 was NOT listening.
Clients could not connect because 8432 wasn't bound.

## Root Causes Found

### 1. `reusePort: true` - Linux-only feature (PRIMARY CAUSE)
**Location:** `src/cluster.js:75`

The cluster mode uses `Bun.listen({ reusePort: true })` which maps to `SO_REUSEPORT`.
This socket option is Linux-only and **silently fails on Windows**.

### 2. Auto-enabled cluster mode on multi-core Windows systems
**Location:** `bin/pglite-server.js:106`

Windows systems with multiple CPU cores automatically entered cluster mode,
triggering the `reusePort` failure.

### 3. TCP port opens before PostgreSQL ready for protocol handshakes
**Location:** `src/postgres.js:803-821`

PostgreSQL was marked "ready" when TCP port opened, but it wasn't actually
ready for protocol-level handshakes. Admin pool connection timed out.

---

## Solution Applied

### Fix 1: Disable cluster mode on Windows
**File:** `bin/pglite-server.js:98-108`
```javascript
const isWindows = os.platform() === 'win32';
cluster: cpuCount > 1 && !isWindows,
```

### Fix 2: Add platform check to reusePort
**File:** `src/cluster.js:72-76`
```javascript
const isWindows = os.platform() === 'win32';
this.server = Bun.listen({
  reusePort: !isWindows,  // SO_REUSEPORT only works on Linux/macOS
  ...
});
```

### Fix 3: Add port binding verification
**File:** `src/cluster.js:99-102`
```javascript
if (!this.server || !this.server.port) {
  throw new Error(`Failed to bind to port ${this.port} - reusePort may not be supported`);
}
```

### Fix 4: Add Windows readiness delay
**File:** `src/postgres.js:813-817`
```javascript
if (isWindows) {
  await Bun.sleep(2000); // 2 second delay for Windows
}
```

### Fix 5: Increase admin pool retry for Windows
**File:** `src/postgres.js:598-599`
```javascript
const maxRetries = isWindows ? 10 : 5;
const baseDelay = isWindows ? 2000 : 1000;
```

---

## Verification

After applying fixes, server runs correctly on Windows:
- Router: `127.0.0.1:7432` ✅
- PostgreSQL: `127.0.0.1:8432` ✅
- Database auto-provisioning: ✅
- Query execution: ✅

```
Server started successfully!

  Endpoint:    postgresql://127.0.0.1:7432/<database>
  Mode:        In-memory (ephemeral)
  PostgreSQL:  Port 8432 (internal)
  Auto-create: Enabled
```

---

## Test Commands (Run from Windows)
```cmd
# Build binary
bun build --compile bin/pglite-server.js --outfile dist/pgserve-windows-x64.exe

# Start server
dist\pgserve-windows-x64.exe

# Check ports are listening (should see BOTH)
netstat -an | findstr "LISTEN" | findstr "8432 9432"

# Test connection
psql postgresql://localhost:8432/testdb
```

---

## Related Files
- `bin/pglite-server.js` - Entry point, cluster mode decision
- `src/cluster.js` - Cluster mode with reusePort
- `src/router.js` - Single-process mode (works on Windows)
- `src/postgres.js` - PostgreSQL startup and admin pool
