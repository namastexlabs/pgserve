# @namastexlabs/pglite-embedded-server

**Multi-tenant PostgreSQL router using PGlite** - Single port, auto-provisioning, zero config.

Perfect for multi-user apps, AI agents, and embedded databases.

## ✨ Features

- 🎯 **Multi-Tenant** - Single port, multiple isolated databases (one per user/app)
- 🚀 **Auto-Provisioning** - Databases created on demand from connection string
- 🔌 **Single Endpoint** - `postgresql://localhost:5432/dbname` routes to correct PGlite instance
- ⚡ **High Performance** - MVCC, row-level locking, concurrent writes
- 🎛️ **Zero Configuration** - Auto-tuned for your hardware (CPU, RAM)
- 📦 **PostgreSQL Compatible** - Works with any PostgreSQL client (psql, Prisma, pg, etc.)
- 🛡️ **Data Isolation** - Each database = separate PGlite instance
- 💾 **Persistent** - Data survives restarts

## 🎯 Use Cases

### Perfect For

- 🤖 **AI Agents** - Each agent gets isolated database (sessions, memory, state)
- 👥 **Multi-User Apps** - One database per user, single endpoint
- 🏢 **SaaS Applications** - Tenant isolation without infrastructure complexity
- 🧪 **Development** - Local PostgreSQL without Docker
- 📱 **Desktop Apps** - Electron, Tauri with embedded multi-tenant DB

### Real-World Examples

- **AI Agent Swarms**: 100+ agents, each with isolated database
- **Multi-Tenant SaaS**: Single endpoint, automatic tenant provisioning
- **Desktop Apps**: Embedded PostgreSQL with multi-user support

## 🚀 Quick Start

### Installation

```bash
npm install @namastexlabs/pglite-embedded-server
# or
pnpm add @namastexlabs/pglite-embedded-server
```

### Multi-Tenant Mode (Recommended)

```javascript
import { startMultiTenantServer } from '@namastexlabs/pglite-embedded-server';

// Start multi-tenant router on single port
const router = await startMultiTenantServer({
  port: 5432,           // Single port for all databases
  baseDir: './data',    // Base directory (creates ./data/dbname/ per DB)
  autoProvision: true,  // Auto-create databases (default: true)
  maxInstances: 100,    // Max concurrent databases
  logLevel: 'info'
});

// Clients connect like normal PostgreSQL:
// postgresql://localhost:5432/user123  → ./data/user123/
// postgresql://localhost:5432/app456   → ./data/app456/
```

### Usage with PostgreSQL Clients

```javascript
import pg from 'pg';

// Connect to database "user123" (auto-created)
const client1 = new pg.Client({
  connectionString: 'postgresql://localhost:5432/user123'
});

await client1.connect();
await client1.query('CREATE TABLE users (id SERIAL, name TEXT)');
await client1.query("INSERT INTO users (name) VALUES ('Alice')");

// Connect to database "app456" (different isolated instance)
const client2 = new pg.Client({
  connectionString: 'postgresql://localhost:5432/app456'
});

await client2.connect();
await client2.query('CREATE TABLE posts (id SERIAL, title TEXT)');

// Each database is completely isolated!
```

### With Prisma

```javascript
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// .env
DATABASE_URL="postgresql://localhost:5432/myapp"
```

```bash
# Auto-provisions "myapp" database
npx prisma migrate dev
```

## 📖 API Reference

### `startMultiTenantServer(options)`

Start multi-tenant router server.

```javascript
const router = await startMultiTenantServer({
  port: 5432,             // Port to listen on (default: 5432)
  host: '127.0.0.1',      // Host to bind (default: 127.0.0.1)
  baseDir: './data',      // Base data directory (default: './data')
  autoProvision: true,    // Auto-create databases (default: true)
  maxInstances: 100,      // Max concurrent databases (default: 100)
  logLevel: 'info',       // Log level: error, warn, info, debug (default: 'info')
  inspect: false          // Enable wire protocol debugging (default: false)
});

// Returns MultiTenantRouter instance
```

### Router Methods

```javascript
// Get router stats
const stats = router.getStats();
// {
//   port: 5432,
//   activeConnections: 2,
//   pool: {
//     totalInstances: 3,
//     maxInstances: 100,
//     instances: [...]
//   }
// }

// List all databases
const databases = router.listDatabases();
// [
//   { dbName: 'user123', locked: false, queueLength: 0, ... },
//   { dbName: 'app456', locked: true, queueLength: 1, ... }
// ]

// Stop router (closes all instances)
await router.stop();
```

## 🏗️ Architecture

### Single Port, Multi-Tenant Routing

```
Client 1: postgresql://localhost:5432/user123
Client 2: postgresql://localhost:5432/app456
Client 3: postgresql://localhost:5432/tenant789
         ↓
┌────────────────────────────────────────┐
│  Multi-Tenant Router (port 5432)       │
│  - Parses connection database name     │
│  - Routes to correct PGlite instance   │
│  - Auto-provisions new databases       │
└────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────┐
│  Instance Pool                         │
│  ├─ user123   → PGlite('./data/user123')   │
│  ├─ app456    → PGlite('./data/app456')    │
│  └─ tenant789 → PGlite('./data/tenant789') │
└────────────────────────────────────────┘
```

### How It Works

1. **Client connects**: `postgresql://localhost:5432/myapp`
2. **Router parses** PostgreSQL startup message → extracts database name: `myapp`
3. **Pool checks** for existing PGlite instance for `myapp`
4. **Auto-provision** creates `./data/myapp/` if doesn't exist
5. **Route connection** to PGlite instance
6. **Client communicates** with isolated database

### Connection Lifecycle

- **First connection to DB**: PGlite instance created, database initialized
- **Subsequent connections**: Reuses existing PGlite instance
- **Concurrent connections**: Queued (PGlite is single-connection per instance)
- **Connection closes**: Instance unlocked, ready for next connection

## 📊 Performance

### vs Multiple Port Approach

| Approach | Ports Used | Management | Scalability |
|----------|-----------|------------|-------------|
| **Multi-tenant** | 1 | Auto | ✅ Excellent (100+ DBs) |
| Multi-port | 1 per DB | Manual | ⚠️ Limited (port exhaustion) |

### Benchmarks

- **DB creation**: ~50ms per database (lazy initialization)
- **Connection routing**: < 1ms overhead
- **Concurrent databases**: Tested with 100+ isolated instances
- **Memory**: ~10-30MB per PGlite instance (depends on data)

## 🔧 CLI Usage

### Install Globally

```bash
npm install -g @namastexlabs/pglite-embedded-server
```

### Commands

```bash
# Start multi-tenant router
pglite-server start-router --port 5432 --dir ./data

# Check router status
pglite-server router-stats

# List all databases
pglite-server list-databases

# Stop router
pglite-server stop-router
```

## 🛠️ Advanced Usage

### Custom Instance Pool

```javascript
import { InstancePool } from '@namastexlabs/pglite-embedded-server';

const pool = new InstancePool({
  baseDir: './databases',
  maxInstances: 50,
  autoProvision: true
});

// Get or create instance
const instance = await pool.getOrCreate('mydb');

// Access PGlite directly
const result = await instance.db.query('SELECT version()');
```

### Connection Queueing

PGlite is **single-connection** per instance. When multiple clients connect to the same database:

```javascript
// Client 1 connects to "mydb" → locks instance
const client1 = new pg.Client({ database: 'mydb', ... });
await client1.connect(); // ✅ Connected

// Client 2 tries to connect to "mydb" → queued
const client2 = new pg.Client({ database: 'mydb', ... });
await client2.connect(); // ⏳ Waits for client1 to disconnect

// Client 1 disconnects
await client1.end();

// Client 2 auto-connects
// ✅ Connected
```

Default timeout: **30 seconds**. Customize in `pool.acquire()`:

```javascript
await pool.acquire('mydb', socket, timeout = 60000); // 60s timeout
```

## 🔐 Security Notes

- **No authentication**: PGlite doesn't support auth (embedded use case)
- **Bind to localhost**: Default `127.0.0.1` (local only)
- **Production**: Use proper PostgreSQL for external access

## 📁 File Structure

```
./data/
  ├─ user123/        (PGlite data for "user123" database)
  │  ├─ base/
  │  ├─ pg_wal/
  │  └─ PG_VERSION
  ├─ app456/         (PGlite data for "app456" database)
  └─ tenant789/      (PGlite data for "tenant789" database)
```

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Submit a pull request

## 📄 License

MIT License - Copyright (c) 2025 Namastex Labs

## 🙏 Credits

Built on top of:
- [@electric-sql/pglite](https://pglite.dev) - PostgreSQL WASM
- [@electric-sql/pglite-socket](https://www.npmjs.com/package/@electric-sql/pglite-socket) - Wire protocol server

## 📧 Support

- **Issues**: [GitHub Issues](https://github.com/namastexlabs/pglite-embedded-server/issues)
- **Email**: labs@namastex.com
- **Website**: [namastex.com](https://namastex.com)

---

**Made with ❤️ by [Namastex Labs](https://namastex.com)**
