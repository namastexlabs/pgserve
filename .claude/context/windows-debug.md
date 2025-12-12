# Windows Debug Context

## Current Issue
PostgreSQL starts successfully on port 9432, but the router/proxy on port 8432 is NOT listening.
Clients cannot connect because 8432 isn't bound.

## What Works
- PostgreSQL binary starts fine
- PostgreSQL reports "ready" on port 9432 (the pgPort = port + 1000)
- No more connection timeout after the retry fix

## What's Broken
- Router/proxy port 8432 is not listening on Windows
- Only PostgreSQL port 9432 is accessible

## Architecture
```
Client -> Router (8432) -> PostgreSQL (9432)
         ^^^^^^^^^^^^^^^^
         THIS IS NOT BINDING ON WINDOWS
```

The router is in `src/router.js` and cluster mode uses `src/cluster.js`.

## Files to Investigate
1. `src/cluster.js` - Cluster mode orchestration (32 workers shown in output)
2. `src/router.js` - Router/proxy that should listen on 8432
3. `bin/pglite-server.js` - Entry point, decides cluster vs single mode

## Key Code Locations
- `src/cluster.js:299-301` - Port configuration: `pgPort = port + 1000`
- `src/router.js:45` - Same port offset logic
- `src/router.js` - `_startServer()` method that creates the TCP server

## Recent Fix Applied
`src/postgres.js:576-623` - Added retry logic with exponential backoff for admin pool initialization.
This fixed the "Connection timeout after 5s" error.

## Test Commands (Run from Windows)
```cmd
# Start server
pgserve-windows-x64.exe

# Check what ports are listening
netstat -an | findstr "LISTEN" | findstr "8432 9432"

# Try connecting to PostgreSQL directly (bypassing router)
psql postgresql://localhost:9432/postgres

# Try connecting through router (this fails currently)
psql postgresql://localhost:8432/testdb
```

## Debug Steps
1. Check if router TCP server is created: Look for `Bun.listen()` or `net.createServer()` in router.js
2. Check if cluster workers are binding correctly on Windows
3. Check if there's a Windows-specific networking issue with the proxy

## Hypothesis
The cluster mode may not be properly starting the router on Windows. The PostgreSQL process starts (child process), but the main Node/Bun process that handles the router proxy may be failing silently.

## User's Windows Output
```
C:\> C:\Users\namastex\Desktop\pgserve-windows-x64.exe

pgserve - Embedded PostgreSQL Server
=====================================

[pgserve] Cluster mode: 32 workers
14:11:00 INFO  {"component":"postgres","databaseDir":"C:\\Users\\namastex\\AppData\\Local\\Temp\\pgserve-20288-1765559460347","persistent":false,"trueRam":false,"port":9432} Starting embedded PostgreSQL
14:11:07 INFO  {"component":"postgres","port":9432,"method":"tcp"} PostgreSQL ready
```

Note: No log showing router started on 8432!
