<div align="center">
  <h1>pgserve</h1>
  <p><strong>Embedded PostgreSQL Server with TRUE Concurrent Connections</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/pgserve"><img src="https://img.shields.io/npm/v/pgserve?style=flat-square&color=00D9FF" alt="npm version"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square" alt="Node.js">
    <img src="https://img.shields.io/badge/PostgreSQL-17.7-blue?style=flat-square" alt="PostgreSQL">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"></a>
    <a href="https://discord.gg/xcW8c7fF3R"><img src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" alt="Discord"></a>
  </p>

  <p><em>Zero config, auto-provision databases, unlimited concurrent connections. Just works.</em></p>

  <p>
    <a href="#features">Features</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#async-replication">Sync</a> •
    <a href="#performance">Performance</a> •
    <a href="#programmatic-api">API</a> •
    <a href="#contributing">Contributing</a>
  </p>
</div>

---

## Quick Start

```bash
# Zero install - just run!
npx pgserve

# Connect from any PostgreSQL client
psql postgresql://localhost:5432/myapp
```

That's it. Database `myapp` is auto-created on first connection.

**Or install globally:**
```bash
npm install -g pgserve
pgserve
```

---

## What is pgserve?

pgserve is an embedded PostgreSQL 17 server that runs anywhere Node.js runs:

- **Native PostgreSQL binaries** - Auto-downloaded on install (no Docker, no system install)
- **TRUE concurrent connections** - Native process forking, not WASM mutex locks
- **Auto-provision databases** - Connect to any database name, it's created automatically
- **Memory mode by default** - Fast, ephemeral, perfect for development

**Key differentiator**: Unlike WASM-based solutions (PGlite), pgserve runs real PostgreSQL with native process forking - unlimited parallel queries, no connection-level locking.

---

## Features

| Feature | Description |
|---------|-------------|
| **TRUE Concurrency** | Native PostgreSQL process forking - unlimited parallel queries |
| **Zero Config** | Just run `pgserve`, connect to any database name |
| **Auto-Provision** | Database created on first connection |
| **Memory Mode** | Default mode - fast, ephemeral (data lost on restart) |
| **Persistent Mode** | Use `--data ./path` to persist databases to disk |
| **Async Replication** | Sync to real PostgreSQL with zero performance impact |
| **Cross-Platform** | Linux x64, macOS ARM64/x64, Windows x64 |
| **PostgreSQL 17.7** | Latest stable, native binaries |
| **Any Client Works** | psql, node-postgres, Prisma, Drizzle, etc. |

---

## Installation

**Zero install (recommended):**
```bash
npx pgserve
```

**Or install globally:**
```bash
npm install -g pgserve
pgserve
```

**Or as a project dependency:**
```bash
npm install pgserve
```

Platform-specific PostgreSQL binaries are automatically downloaded on first run.

---

## Usage

### CLI Options

```
pgserve [options]

Options:
  --port <number>       PostgreSQL port (default: 5432)
  --data <path>         Data directory for persistence (default: in-memory)
  --host <host>         Host to bind to (default: 127.0.0.1)
  --log <level>         Log level: error, warn, info, debug (default: info)
  --cluster             Force cluster mode (auto-enabled on multi-core systems)
  --no-cluster          Force single-process mode
  --workers <n>         Number of worker processes (default: CPU cores)
  --no-provision        Disable auto-provisioning of databases
  --sync-to <url>       Sync to real PostgreSQL (async replication)
  --sync-databases <p>  Database patterns to sync (comma-separated, e.g. "myapp,tenant_*")
  --help                Show help message
```

### Examples

```bash
# Development (memory mode - fast, disposable)
# Auto-clusters on multi-core systems for best performance
pgserve

# Single-process mode (simpler logs, less memory)
pgserve --no-cluster

# Production (persistent data)
pgserve --data /var/lib/pgserve

# Custom port
pgserve --port 5433

# Explicit cluster with specific worker count
pgserve --cluster --workers 4

# Debug logging
pgserve --log debug

# Persistent with custom port
pgserve --port 5433 --data ./mydata

# Sync to real PostgreSQL (async replication)
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/prod"

# Sync specific databases only
pgserve --sync-to "postgresql://..." --sync-databases "myapp,tenant_*"
```

### Connecting

Any database name auto-creates:

```bash
# These all work - databases auto-created on first connection
postgresql://localhost:5432/myapp
postgresql://localhost:5432/tenant_123
postgresql://localhost:5432/test_db
```

---

## Programmatic API

```javascript
import { startMultiTenantServer } from 'pgserve';

// Start server
const server = await startMultiTenantServer({
  port: 5432,
  host: '127.0.0.1',
  baseDir: null,      // null = memory mode, or path for persistence
  logLevel: 'info',
  autoProvision: true
});

// Connect using any PostgreSQL client
// postgresql://localhost:5432/any_database_name

// Get server stats
const stats = server.getStats();
console.log(stats);

// Graceful shutdown
await server.stop();
```

### With node-postgres

```javascript
import pg from 'pg';

// Connect to auto-created database
const client = new pg.Client({
  connectionString: 'postgresql://localhost:5432/myapp'
});

await client.connect();
await client.query('CREATE TABLE users (id SERIAL, name TEXT)');
await client.query("INSERT INTO users (name) VALUES ('Alice')");
const result = await client.query('SELECT * FROM users');
console.log(result.rows);
await client.end();
```

### With Prisma

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```bash
# .env
DATABASE_URL="postgresql://localhost:5432/myapp"

# Run migrations (auto-provisions "myapp" database)
npx prisma migrate dev
```

---

## Async Replication

Sync your ephemeral pgserve data to a real PostgreSQL database asynchronously. Uses PostgreSQL's native logical replication for **zero performance impact** on the hot path.

### How It Works

```
┌─────────────────────────────────────────┐
│   pgserve (Memory Mode - HOT PATH)       │
│   Fast, ephemeral, zero config           │
└─────────────────────┬───────────────────┘
                      │ PostgreSQL Logical Replication
                      │ (async, non-blocking)
                      ▼
┌─────────────────────────────────────────┐
│   Real PostgreSQL (AWS RDS, Supabase)    │
│   Persistent, production-ready           │
└─────────────────────────────────────────┘
```

### CLI Usage

```bash
# Sync all databases to real PostgreSQL
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/mydb"

# Sync only specific databases (supports wildcards)
pgserve --sync-to "postgresql://..." --sync-databases "myapp,tenant_*"
```

### Programmatic API

```javascript
import { startMultiTenantServer } from 'pgserve';

const server = await startMultiTenantServer({
  port: 5432,
  syncTo: 'postgresql://user:pass@prod-db.example.com:5432/main',
  syncDatabases: 'app_*,users'  // Optional: patterns for selective sync
});
```

### Key Benefits

- **Zero Hot Path Impact** - Replication handled by PostgreSQL WAL writer, not Node.js
- **Non-Blocking** - Sync failures don't affect main server operation
- **Selective Sync** - Choose which databases to replicate using patterns
- **Native PostgreSQL** - Uses built-in logical replication (no custom protocols)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Client Connections                      │
│           (psql, pg, Prisma, Drizzle, etc.)             │
└─────────────────────────┬───────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              │   MultiTenantRouter   │
              │      (TCP Proxy)      │
              │  - Extract DB name    │
              │  - Auto-provision     │
              │  - Route connections  │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │   PostgresManager     │
              │  (Binary Execution)   │
              │  - Direct PG binaries │
              │  - No locale deps     │
              └───────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │   PostgreSQL 17.7     │
              │   (Native Process)    │
              │   TRUE CONCURRENCY    │
              │   Unlimited Parallel  │
              └───────────────────────┘
```

### How It Works

1. **Client connects**: `postgresql://localhost:5432/myapp`
2. **Router extracts** database name from PostgreSQL handshake
3. **Auto-provision** creates database if it doesn't exist
4. **TCP proxy** forwards connection to PostgreSQL
5. **Native PostgreSQL** handles the connection with process forking

---

## Comparison

| Feature | pgserve | PGlite | Docker Postgres |
|---------|---------|--------|-----------------|
| Concurrent Connections | **Unlimited** | 1 per DB | Unlimited |
| Zero Config | Yes | Yes | No |
| Auto-Download | Yes | Yes | No |
| Memory Mode | Yes | Yes | No |
| Native Performance | Yes | No (WASM) | Yes |
| No Docker Required | Yes | Yes | No |
| Database Size | Unlimited | ~1GB limit | Unlimited |

---

## Performance

**Real benchmark results (December 2025):**

| Scenario | SQLite | PGlite | PostgreSQL | pgserve | Winner |
|----------|--------|--------|------------|---------|--------|
| **Concurrent Writes** (10 agents) | 100 qps | 219 qps | 758 qps | **855 qps** | **pgserve** |
| **Mixed Workload** (messages) | 335 qps | 506 qps | 940 qps | **1034 qps** | **pgserve** |
| **Write Lock** (50 writers) | 98 qps | 201 qps | 478 qps | 391 qps | PostgreSQL |

*PostgreSQL = Docker with disk storage (realistic production comparison)*

### pgserve vs PGlite (embedded comparison)

| Scenario | pgserve | PGlite | Advantage |
|----------|---------|--------|-----------|
| Concurrent Writes | 855 qps | 219 qps | **3.9x faster** |
| Mixed Workload | 1034 qps | 506 qps | **2.0x faster** |
| Write Lock | 391 qps | 201 qps | **1.9x faster** |

### pgserve vs Docker PostgreSQL

| Scenario | pgserve | PostgreSQL | Result |
|----------|---------|------------|--------|
| Concurrent Writes | **855 qps** | 758 qps | **12.8% faster** |
| Mixed Workload | **1034 qps** | 940 qps | **10% faster** |
| Write Lock | 391 qps | 478 qps | 82% of Docker |

**Key takeaway:** pgserve now beats Docker PostgreSQL in 2/3 scenarios thanks to smart auto-clustering. For development, CI/CD, and ephemeral deployments, pgserve offers better-than-Docker performance without Docker.

> Run benchmarks yourself: `npm run bench`

---

## Requirements

- **Node.js** >= 18.0.0
- **Platform**: Linux x64, macOS ARM64/x64, or Windows x64

---

## Use Cases

- **Local Development** - PostgreSQL without Docker or system install
- **Testing & CI/CD** - Fast, ephemeral databases per test run
- **AI Agents** - Each agent gets isolated database
- **Multi-Tenant Apps** - Auto-provision databases per tenant
- **Prototyping** - Zero setup, just connect

---

## Contributing

Contributions welcome!

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Submit a pull request

---

## License

MIT License - Copyright (c) 2025 Namastex Labs

---

## Links

- **GitHub**: [github.com/namastexlabs/pgserve](https://github.com/namastexlabs/pgserve)
- **Issues**: [github.com/namastexlabs/pgserve/issues](https://github.com/namastexlabs/pgserve/issues)
- **npm**: [npmjs.com/package/pgserve](https://www.npmjs.com/package/pgserve)

---

## Credits

Built with:
- [embedded-postgres](https://github.com/leinelissen/embedded-postgres) - PostgreSQL binaries for Node.js
- [@embedded-postgres/*](https://www.npmjs.com/search?q=%40embedded-postgres) - Platform-specific native binaries

---

<p align="center">
  Made with ❤️ by <a href="https://namastex.ai">Namastex Labs</a><br>
  <em>AI that elevates human potential, not replaces it</em>
</p>
