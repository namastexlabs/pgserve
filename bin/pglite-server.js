#!/usr/bin/env bun

/**
 * pgserve - Embedded PostgreSQL Server
 *
 * True concurrent connections, zero config, auto-provision databases.
 * Uses embedded-postgres (real PostgreSQL binaries).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import { startMultiTenantServer } from '../src/index.js';
import { startClusterServer } from '../src/cluster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global error handlers
process.on('unhandledRejection', (reason, _promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Parse CLI arguments
const args = process.argv.slice(2);

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
pgserve - Embedded PostgreSQL Server
=====================================

True concurrent connections, zero config, auto-provision databases.

USAGE:
  pgserve [options]

OPTIONS:
  --port <number>    PostgreSQL port (default: 8432)
  --data <path>      Data directory for persistence (default: in-memory)
  --ram              Use RAM storage via /dev/shm (Linux only, faster)
  --host <host>      Host to bind to (default: 127.0.0.1)
  --log <level>      Log level: error, warn, info, debug (default: info)
  --cluster          Force cluster mode (auto-enabled on multi-core systems)
  --no-cluster       Force single-process mode (disables auto-cluster)
  --workers <n>      Number of worker processes (default: CPU cores)
  --no-provision     Disable auto-provisioning of databases
  --sync-to <url>    Sync to real PostgreSQL (async replication)
  --sync-databases   Database patterns to sync (comma-separated, e.g. "myapp,tenant_*")
  --no-stats         Disable real-time stats dashboard (enabled by default)
  --max-connections  Max concurrent connections (default: 1000)
  --help             Show this help message

MODES:
  In-memory (default):  Ephemeral temp directory - data lost on restart
  RAM mode (--ram):     True RAM via /dev/shm (Linux only, fastest)
  Persistent:           Use --data to persist databases to disk

EXAMPLES:
  # Start in memory mode (default, fast, ephemeral)
  pgserve

  # Start with persistent storage
  pgserve --data ./data

  # Custom port
  pgserve --port 5433

  # Sync to real PostgreSQL (async replication)
  pgserve --sync-to "postgresql://user:pass@host:5432/db"

  # Sync specific databases
  pgserve --sync-to "postgresql://..." --sync-databases "myapp,tenant_*"

CONNECTING:
  # Any PostgreSQL client works (psql, pg, Prisma, etc.)
  postgresql://localhost:5432/mydb     # Auto-creates "mydb" database
  postgresql://localhost:5432/app123   # Auto-creates "app123" database

FEATURES:
  - TRUE concurrent connections (native PostgreSQL)
  - Auto-provision databases on first connection
  - Zero configuration required
  - PostgreSQL 17 (native binaries, auto-downloaded)
`);
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  // Auto-enable cluster mode on multi-core systems for best performance
  // Note: Cluster mode uses SO_REUSEPORT which is not supported on Windows
  const cpuCount = os.cpus().length;
  const isWindows = os.platform() === 'win32';

  const options = {
    port: 8432,
    host: '127.0.0.1',
    dataDir: null, // null = memory mode
    useRam: false, // Use /dev/shm for true RAM storage (Linux only)
    logLevel: 'info',
    autoProvision: true,
    cluster: cpuCount > 1 && !isWindows,  // Auto-enable on multi-core (disabled on Windows - no SO_REUSEPORT)
    workers: null, // null = use CPU count
    syncTo: null,  // Sync target PostgreSQL URL
    syncDatabases: null, // Database patterns to sync (comma-separated)
    showStats: true, // Show real-time stats dashboard (default: enabled)
    maxConnections: 1000 // Max concurrent connections (high default for multi-tenant)
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--port':
      case '-p':
        options.port = parseInt(args[++i], 10);
        break;

      case '--data':
      case '-d':
        options.dataDir = args[++i];
        break;

      case '--ram':
        options.useRam = true;
        break;

      case '--host':
      case '-h':
        options.host = args[++i];
        break;

      case '--log':
      case '-l':
        options.logLevel = args[++i];
        break;

      case '--cluster':
        options.cluster = true;
        break;

      case '--no-cluster':
        options.cluster = false;
        break;

      case '--workers':
        options.workers = parseInt(args[++i], 10);
        break;

      case '--no-provision':
        options.autoProvision = false;
        break;

      case '--sync-to':
        options.syncTo = args[++i];
        break;

      case '--sync-databases':
        options.syncDatabases = args[++i];
        break;

      case '--stats':
        options.showStats = true;
        break;

      case '--no-stats':
        options.showStats = false;
        break;

      case '--max-connections':
        options.maxConnections = parseInt(args[++i], 10);
        break;

      case '--help':
      case 'help':
        printHelp();
        process.exit(0);
        // falls through (unreachable - exit above)

      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  return options;
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();
  const memoryMode = !options.dataDir;
  const storageType = options.dataDir
    ? options.dataDir
    : (options.useRam ? '/dev/shm (RAM)' : '(temp directory)');

  // Only print header if not a cluster worker (workers get PGSERVE_WORKER env)
  if (!process.env.PGSERVE_WORKER) {
    console.log(`
pgserve - Embedded PostgreSQL Server
=====================================
`);
  }

  try {
    let server;

    if (options.cluster) {
      // Cluster mode - multi-core scaling
      server = await startClusterServer({
        port: options.port,
        host: options.host,
        baseDir: options.dataDir,
        useRam: options.useRam,
        logLevel: options.logLevel,
        autoProvision: options.autoProvision,
        workers: options.workers,
        maxConnections: options.maxConnections
      });

      // Only primary process shows full startup message
      if (server.workers) {
        const stats = server.getStats();

        console.log(`
Cluster started successfully!

  Endpoint:    postgresql://${options.host}:${options.port}/<database>
  Mode:        ${memoryMode ? (options.useRam ? 'RAM (/dev/shm)' : 'Ephemeral (temp)') : 'Persistent'} (Cluster)
  Workers:     ${stats.workers} processes
  Data:        ${storageType}
  Auto-create: ${options.autoProvision ? 'Enabled' : 'Disabled'}

Examples:
  postgresql://${options.host}:${options.port}/myapp
  postgresql://${options.host}:${options.port}/testdb

Press Ctrl+C to stop
`);
      }
    } else {
      // Single process mode
      const router = await startMultiTenantServer({
        port: options.port,
        host: options.host,
        baseDir: options.dataDir,
        useRam: options.useRam,
        logLevel: options.logLevel,
        autoProvision: options.autoProvision,
        syncTo: options.syncTo,
        syncDatabases: options.syncDatabases,
        maxConnections: options.maxConnections
      });

      server = router;

      // Build sync status string
      const syncStatus = options.syncTo
        ? `Enabled → ${options.syncTo.replace(/:[^:@]+@/, ':***@')}`
        : 'Disabled';

      console.log(`
Server started successfully!

  Endpoint:    postgresql://${options.host}:${options.port}/<database>
  Mode:        ${memoryMode ? (options.useRam ? 'RAM (/dev/shm)' : 'Ephemeral (temp)') : 'Persistent'}
  Data:        ${storageType}
  PostgreSQL:  Port ${router.pgPort} (internal)
  Auto-create: ${options.autoProvision ? 'Enabled' : 'Disabled'}
  Sync:        ${syncStatus}${options.syncDatabases ? ` (${options.syncDatabases})` : ''}

Examples:
  postgresql://${options.host}:${options.port}/myapp
  postgresql://${options.host}:${options.port}/testdb

Press Ctrl+C to stop
`);
    }

    // Start stats dashboard if requested (only for primary/single-process)
    let dashboard = null;
    if (options.showStats && !process.env.PGSERVE_WORKER) {
      const { StatsDashboard } = await import('../src/stats-dashboard.js');
      const { StatsCollector } = await import('../src/stats-collector.js');

      // Create stats collector with appropriate sources
      const collector = new StatsCollector({
        router: options.cluster ? null : server,
        pgManager: server.pgManager,
        clusterStats: options.cluster ? () => server.getStats() : null,
        logger: server.logger,
        port: options.port,
        host: options.host
      });

      dashboard = new StatsDashboard({
        refreshInterval: 2000, // 2 second refresh for real-time feel
        statsProvider: () => collector.collect()
      });

      dashboard.start();
    }

    // Graceful shutdown (only for primary/single-process, workers handle via IPC)
    if (!process.env.PGSERVE_WORKER) {
      const shutdown = async () => {
        // Stop dashboard first to restore cursor
        if (dashboard) {
          dashboard.stop();
        }
        console.log('\nShutting down...');
        try {
          await server.stop();
          console.log('Server stopped.');
        } catch (err) {
          console.error('Error during shutdown:', err.message);
          // Still exit - best effort cleanup
        }
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    }

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`Failed to start server:`, error);
    process.exit(1);
  }
}

main();
