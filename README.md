<div align="center">
  <h1>pgserve</h1>
  <p><strong>Embedded PostgreSQL Server with TRUE Concurrent Connections</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/pgserve"><img src="https://img.shields.io/npm/v/pgserve?style=flat-square&color=00D9FF" alt="npm version"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square" alt="Node.js">
    <img src="https://img.shields.io/badge/PostgreSQL-17.7-blue?style=flat-square" alt="PostgreSQL">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License"></a>
    <a href="https://discord.gg/xcW8c7fF3R"><img src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" alt="Discord"></a>
  </p>

  <p><em>Zero config, auto-provision databases, unlimited concurrent connections. Just works.</em></p>

  <p>
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-features">Features</a> •
    <a href="#-cli-reference">CLI</a> •
    <a href="#-api">API</a> •
    <a href="#-performance">Performance</a>
  </p>
</div>

<br>

## Quick Start

```bash
npx pgserve
```

Connect from any PostgreSQL client — databases auto-create on first connection:

```bash
psql postgresql://localhost:8432/myapp
```

<br>

## Features

<table>
  <tr>
    <td><b>Real PostgreSQL 17</b></td>
    <td>Native binaries, not WASM — full compatibility, extensions support</td>
  </tr>
  <tr>
    <td><b>Unlimited Concurrency</b></td>
    <td>Native PostgreSQL process forking — no connection locks</td>
  </tr>
  <tr>
    <td><b>Zero Config</b></td>
    <td>Just run <code>pgserve</code>, connect to any database name</td>
  </tr>
  <tr>
    <td><b>Auto-Provision</b></td>
    <td>Databases created automatically on first connection</td>
  </tr>
  <tr>
    <td><b>Memory Mode</b></td>
    <td>Fast and ephemeral for development (default)</td>
  </tr>
  <tr>
    <td><b>RAM Mode</b></td>
    <td>Use <code>--ram</code> for /dev/shm storage (Linux, 2x faster)</td>
  </tr>
  <tr>
    <td><b>Persistent Mode</b></td>
    <td>Use <code>--data ./path</code> for durable storage</td>
  </tr>
  <tr>
    <td><b>Async Replication</b></td>
    <td>Sync to real PostgreSQL with minimal overhead</td>
  </tr>
  <tr>
    <td><b>Cross-Platform</b></td>
    <td>Linux x64, macOS ARM64/x64, Windows x64</td>
  </tr>
  <tr>
    <td><b>Any Client Works</b></td>
    <td>psql, node-postgres, Prisma, Drizzle, TypeORM</td>
  </tr>
</table>

<br>

## Installation

```bash
# Zero install (recommended)
npx pgserve

# Global install
npm install -g pgserve

# Project dependency
npm install pgserve
```

> PostgreSQL binaries are automatically downloaded on first run (~100MB).

### Windows

Download `pgserve-windows-x64.exe` from [GitHub Releases](https://github.com/namastexlabs/pgserve/releases).

Double-click to run, or use CLI:

```cmd
pgserve-windows-x64.exe --port 5432
pgserve-windows-x64.exe --data C:\pgserve-data
```

<br>

## CLI Reference

```
pgserve [options]

Options:
  --port <number>       PostgreSQL port (default: 8432)
  --data <path>         Data directory for persistence (default: in-memory)
  --ram                 Use RAM storage via /dev/shm (Linux only, fastest)
  --host <host>         Host to bind to (default: 127.0.0.1)
  --log <level>         Log level: error, warn, info, debug (default: info)
  --cluster             Force cluster mode (auto-enabled on multi-core)
  --no-cluster          Force single-process mode
  --workers <n>         Number of worker processes (default: CPU cores)
  --no-provision        Disable auto-provisioning of databases
  --sync-to <url>       Sync to real PostgreSQL (async replication)
  --sync-databases <p>  Database patterns to sync (comma-separated)
  --help                Show help message
```

<details>
<summary><b>Examples</b></summary>

```bash
# Development (memory mode, auto-clusters on multi-core)
pgserve

# RAM mode (Linux only, 2x faster)
pgserve --ram

# Persistent storage
pgserve --data /var/lib/pgserve

# Custom port
pgserve --port 5433

# Sync to production PostgreSQL
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/prod"
```

</details>

<br>

## API

```javascript
import { startMultiTenantServer } from 'pgserve';

const server = await startMultiTenantServer({
  port: 8432,
  host: '127.0.0.1',
  baseDir: null,        // null = memory mode
  logLevel: 'info',
  autoProvision: true,
  syncTo: null,         // Optional: PostgreSQL URL for replication
  syncDatabases: null   // Optional: patterns like "myapp,tenant_*"
});

// Get stats
console.log(server.getStats());

// Graceful shutdown
await server.stop();
```

<br>

## Framework Integration

<details>
<summary><b>node-postgres</b></summary>

```javascript
import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://localhost:8432/myapp'
});

await client.connect();
await client.query('CREATE TABLE users (id SERIAL, name TEXT)');
await client.query("INSERT INTO users (name) VALUES ('Alice')");
const result = await client.query('SELECT * FROM users');
console.log(result.rows);
await client.end();
```

</details>

<details>
<summary><b>Prisma</b></summary>

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

```bash
# .env
DATABASE_URL="postgresql://localhost:8432/myapp"

# Run migrations
npx prisma migrate dev
```

</details>

<details>
<summary><b>Drizzle</b></summary>

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgresql://localhost:8432/myapp'
});

const db = drizzle(pool);
const users = await db.select().from(usersTable);
```

</details>

<br>

## Async Replication

Sync ephemeral pgserve data to a real PostgreSQL database. Uses native logical replication for **zero performance impact** on the hot path.

```bash
# Sync all databases
pgserve --sync-to "postgresql://user:pass@db.example.com:5432/mydb"

# Sync specific databases (supports wildcards)
pgserve --sync-to "postgresql://..." --sync-databases "myapp,tenant_*"
```

> Replication is handled by PostgreSQL's WAL writer process, completely off the runtime event loop. Sync failures don't affect main server operation.

<br>

## Performance

### CRUD Benchmarks

<table>
  <tr>
    <th>Scenario</th>
    <th>SQLite</th>
    <th>PGlite</th>
    <th>PostgreSQL</th>
    <th>pgserve</th>
    <th>pgserve --ram</th>
  </tr>
  <tr>
    <td><b>Concurrent Writes</b> (10 agents)</td>
    <td>91 qps</td>
    <td>204 qps</td>
    <td>1,667 qps</td>
    <td>2,273 qps</td>
    <td><b>4,167 qps</b> 🏆</td>
  </tr>
  <tr>
    <td><b>Mixed Workload</b></td>
    <td>383 qps</td>
    <td>484 qps</td>
    <td>507 qps</td>
    <td>1,133 qps</td>
    <td><b>2,109 qps</b> 🏆</td>
  </tr>
  <tr>
    <td><b>Write Lock</b> (50 writers)</td>
    <td>111 qps</td>
    <td>228 qps</td>
    <td>2,857 qps</td>
    <td>3,030 qps</td>
    <td><b>4,348 qps</b> 🏆</td>
  </tr>
</table>

### Vector Benchmarks (pgvector)

<table>
  <tr>
    <th>Metric</th>
    <th>PGlite</th>
    <th>PostgreSQL</th>
    <th>pgserve</th>
    <th>pgserve --ram</th>
  </tr>
  <tr>
    <td><b>Vector INSERT</b> (1000 × 1536-dim)</td>
    <td>152/sec</td>
    <td>392/sec</td>
    <td>387/sec</td>
    <td><b>1,082/sec</b> 🏆</td>
  </tr>
  <tr>
    <td><b>k-NN Search</b> (k=10, 10k corpus)</td>
    <td>22 qps</td>
    <td>33 qps</td>
    <td>31 qps</td>
    <td>30 qps</td>
  </tr>
  <tr>
    <td><b>Recall@10</b></td>
    <td>100%</td>
    <td>100%</td>
    <td>100%</td>
    <td>100%</td>
  </tr>
</table>

> <b>Why pgserve wins on writes:</b> RAM mode uses <code>/dev/shm</code> (tmpfs), eliminating fsync latency. Vector search is CPU-bound, so RAM mode shows minimal benefit there.

### Final Score

<table>
  <tr>
    <th>Engine</th>
    <th>CRUD QPS</th>
    <th>Vec QPS</th>
    <th>Recall</th>
    <th>P50</th>
    <th>P99</th>
    <th>Score</th>
  </tr>
  <tr>
    <td>SQLite</td>
    <td>195</td>
    <td>N/A</td>
    <td>N/A</td>
    <td>6.3ms</td>
    <td>17.3ms</td>
    <td>117</td>
  </tr>
  <tr>
    <td>PGlite</td>
    <td>305</td>
    <td>65</td>
    <td>100%</td>
    <td>3.3ms</td>
    <td>7.0ms</td>
    <td>209</td>
  </tr>
  <tr>
    <td>PostgreSQL</td>
    <td>1,677</td>
    <td>152</td>
    <td>100%</td>
    <td>6.0ms</td>
    <td>19.0ms</td>
    <td>1,067</td>
  </tr>
  <tr>
    <td>pgserve</td>
    <td>2,145</td>
    <td>149</td>
    <td>100%</td>
    <td>5.3ms</td>
    <td>13.0ms</td>
    <td>1,347</td>
  </tr>
  <tr>
    <td><b>pgserve --ram</b></td>
    <td><b>3,541</b></td>
    <td><b>381</b></td>
    <td><b>100%</b></td>
    <td><b>3.3ms</b></td>
    <td><b>10.7ms</b></td>
    <td><b>2,277</b> 🏆</td>
  </tr>
</table>

> <b>Methodology:</b> Recall@k measured against brute-force ground truth (industry standard). PostgreSQL baseline is Docker <code>pgvector/pgvector:pg17</code>. RAM mode available on Linux and WSL2.
>
> Run benchmarks yourself: <code>bun tests/benchmarks/runner.js --include-vector</code>

<br>

## Use Cases

<table>
  <tr>
    <td width="50%">
      <h4>Development & Testing</h4>
      <ul>
        <li><b>Local Development</b> — PostgreSQL without Docker</li>
        <li><b>Integration Testing</b> — Real PostgreSQL, not mocks</li>
        <li><b>CI/CD Pipelines</b> — Fresh databases per test run</li>
        <li><b>E2E Testing</b> — Isolated database for Playwright/Cypress</li>
      </ul>
    </td>
    <td width="50%">
      <h4>AI & Agents</h4>
      <ul>
        <li><b>AI Agent Memory</b> — Isolated, concurrent-safe database</li>
        <li><b>LLM Tool Use</b> — Give AI models a real PostgreSQL</li>
        <li><b>RAG Applications</b> — Store embeddings with pgvector</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h4>Multi-Tenant & SaaS</h4>
      <ul>
        <li><b>Tenant Isolation</b> — Auto-provision per tenant</li>
        <li><b>Demo Environments</b> — Instant sandboxed PostgreSQL</li>
        <li><b>Microservices Dev</b> — Each service gets its own DB</li>
      </ul>
    </td>
    <td width="50%">
      <h4>Edge & Embedded</h4>
      <ul>
        <li><b>IoT Devices</b> — Full PostgreSQL on Raspberry Pi</li>
        <li><b>Desktop Apps</b> — Electron with embedded PostgreSQL</li>
        <li><b>Offline-First</b> — Local DB that syncs when online</li>
      </ul>
    </td>
  </tr>
</table>

<br>

## Requirements

- **Runtime**: Node.js >= 18 (npm/npx)
- **Platform**: Linux x64, macOS ARM64/x64, Windows x64

<br>

## Development

Contributors: This project uses Bun internally for development:

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run benchmarks
bun tests/benchmarks/runner.js

# Lint
bun run lint
```

<br>

## Contributing

Contributions welcome! Fork the repo, create a feature branch, add tests, and submit a PR.

<br>

---

<div align="center">
  <p>
    <b>MIT License</b> — Copyright (c) 2025 Namastex Labs
  </p>
  <p>
    <a href="https://github.com/namastexlabs/pgserve">GitHub</a> •
    <a href="https://www.npmjs.com/package/pgserve">npm</a> •
    <a href="https://github.com/namastexlabs/pgserve/issues">Issues</a>
  </p>
  <p>
    Made with love by <a href="https://namastex.ai">Namastex Labs</a>
  </p>
</div>
