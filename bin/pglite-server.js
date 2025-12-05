#!/usr/bin/env node

/**
 * pgserve - Embedded PostgreSQL Server
 *
 * True concurrent connections, zero config, auto-provision databases.
 * Uses embedded-postgres (real PostgreSQL binaries).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { startMultiTenantServer } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
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
  --port <number>    PostgreSQL port (default: 5432)
  --data <path>      Data directory for persistence (default: in-memory)
  --host <host>      Host to bind to (default: 127.0.0.1)
  --log <level>      Log level: error, warn, info, debug (default: info)
  --no-provision     Disable auto-provisioning of databases
  --help             Show this help message

MODES:
  In-memory (default):  Fast, ephemeral - data lost on restart
  Persistent:           Use --data to persist databases to disk

EXAMPLES:
  # Start in memory mode (default, fast, ephemeral)
  pgserve

  # Start with persistent storage
  pgserve --data ./data

  # Custom port
  pgserve --port 5433

  # Custom port with persistence
  pgserve --port 5433 --data /var/lib/pgserve

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
  const options = {
    port: 5432,
    host: '127.0.0.1',
    dataDir: null, // null = memory mode
    logLevel: 'info',
    autoProvision: true
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

      case '--host':
      case '-h':
        options.host = args[++i];
        break;

      case '--log':
      case '-l':
        options.logLevel = args[++i];
        break;

      case '--no-provision':
        options.autoProvision = false;
        break;

      case '--help':
      case 'help':
        printHelp();
        process.exit(0);

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

  console.log(`
pgserve - Embedded PostgreSQL Server
=====================================
`);

  try {
    const router = await startMultiTenantServer({
      port: options.port,
      host: options.host,
      baseDir: options.dataDir,
      logLevel: options.logLevel,
      autoProvision: options.autoProvision
    });

    console.log(`
Server started successfully!

  Endpoint:    postgresql://${options.host}:${options.port}/<database>
  Mode:        ${memoryMode ? 'In-memory (ephemeral)' : 'Persistent'}
  Data:        ${memoryMode ? '(temp directory)' : options.dataDir}
  PostgreSQL:  Port ${router.pgPort} (internal)
  Auto-create: ${options.autoProvision ? 'Enabled' : 'Disabled'}

Examples:
  postgresql://${options.host}:${options.port}/myapp
  postgresql://${options.host}:${options.port}/testdb

Press Ctrl+C to stop
`);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await router.stop();
      console.log('Server stopped.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`Failed to start server:`, error);
    process.exit(1);
  }
}

main();
