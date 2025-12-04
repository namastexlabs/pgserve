#!/usr/bin/env node

import { fileURLToPath } from 'url';
import path from 'path';
import {
  startServer,
  stopServer,
  list,
  findByDataDir,
  findByPort,
  portInfo,
  cleanup,
  startMultiTenantServer
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  // ExitStatus errors are expected from PGlite WASM cleanup - ignore them
  if (reason && reason.name === 'ExitStatus') {
    return;
  }
  console.error('❌ Unhandled Promise Rejection:', reason);
  // Don't exit - log and continue (PM2 will handle restarts if needed)
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Parse CLI arguments
const args = process.argv.slice(2);

// Default to router mode if first arg is a flag (e.g., --port) or no args
let command = args[0];
if (command?.startsWith('--') || command === undefined) {
  command = 'router';
  // Don't modify args - router will parse them
}

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  pgserve - Multi-Tenant PostgreSQL Router using PGlite           ║
╚═══════════════════════════════════════════════════════════════════╝

USAGE:
  pgserve <command> [options]

COMMANDS:
  🚀 MULTI-TENANT MODE (Recommended):

  router                       Start multi-tenant router (single port, auto-provision)
    --port <number>            PostgreSQL port (default: 8432)
    --data <path>              Base directory for databases (enables persistence)
    --max <number>             Max concurrent databases (default: 100)
    --log <level>              Log level: error, warn, info, debug (default: info)
    --no-provision             Disable auto-provisioning

  📦 LEGACY MODE (Single instance):

  start <dataDir>              Start server for specific data directory
    --port <number>            Use specific port (default: auto-allocate 12000-12999)
    --log <level>              Log level (default: info)

  stop <dataDir>               Stop server by data directory
  stop --port <number>         Stop server by port
  stop --all                   Stop all running instances

  list                         List all running instances

  url <dataDir>                Get connection URL for instance

  health <dataDir>             Check health of instance
  health --port <number>       Check health by port

  cleanup                      Remove stale instances from registry

  info                         Show port range and system info

  help                         Show this help message

EXAMPLES:
  🚀 Multi-tenant mode (RECOMMENDED):

  # Start router (in-memory mode, default)
  pgserve

  # Start with persistent storage
  pgserve --data ./data

  # Custom port with persistence
  pgserve --port 8433 --data /var/lib/pglite

  # Connect clients:
  # postgresql://localhost:8432/user123    → in-memory db "user123"
  # postgresql://localhost:8432/app456     → in-memory db "app456"

  📦 Legacy mode:

  # Start single instance
  pgserve start ./data/my-db --port 12000

  # List instances
  pgserve list

  # Stop all
  pgserve stop --all

`);
}

/**
 * Format uptime
 */
function formatUptime(started) {
  const now = new Date();
  const start = new Date(started);
  const diff = now - start;

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Command: start
 */
async function cmdStart() {
  const dataDir = args[1];

  if (!dataDir) {
    console.error('❌ Error: Data directory required');
    console.log('Usage: pglite-server start <dataDir> [--port <number>]');
    process.exit(1);
  }

  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? parseInt(args[portIndex + 1], 10) : null;

  const logIndex = args.indexOf('--log');
  const logLevel = logIndex >= 0 ? args[logIndex + 1] : 'info';

  try {
    const instance = await startServer({ dataDir, port, logLevel });

    console.log(`\n✅ Server started successfully`);
    console.log(`📍 Connection: ${instance.connectionUrl}`);
    console.log(`📁 Data: ${instance.dataDir}`);
    console.log(`🔌 Port: ${instance.port}`);
    console.log(`🆔 PID: ${instance.pid}`);
    console.log(`\nPress Ctrl+C to stop\n`);

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`❌ Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Command: stop
 */
async function cmdStop() {
  const stopAll = args.includes('--all');

  if (stopAll) {
    const instances = list();

    if (instances.length === 0) {
      console.log('ℹ️  No running instances');
      return;
    }

    console.log(`🛑 Stopping ${instances.length} instances...`);

    for (const instance of instances) {
      try {
        await stopServer({ dataDir: instance.dataDir });
      } catch (error) {
        console.error(`⚠️  Failed to stop ${instance.dataDir}: ${error.message}`);
      }
    }

    console.log(`✅ Stopped ${instances.length} instances`);
    return;
  }

  const portIndex = args.indexOf('--port');

  if (portIndex >= 0) {
    const port = parseInt(args[portIndex + 1], 10);
    try {
      await stopServer({ port });
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    return;
  }

  const dataDir = args[1];

  if (!dataDir) {
    console.error('❌ Error: Data directory or --port required');
    console.log('Usage: pglite-server stop <dataDir> | --port <number> | --all');
    process.exit(1);
  }

  try {
    await stopServer({ dataDir });
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}

/**
 * Command: list
 */
function cmdList() {
  const instances = list();

  if (instances.length === 0) {
    console.log('ℹ️  No running instances');
    return;
  }

  console.log('\nActive Instances:');
  console.log('┌────────┬─────────────────────────────────────────────┬────────┬─────────────┐');
  console.log('│ Port   │ Data Directory                              │ PID    │ Uptime      │');
  console.log('├────────┼─────────────────────────────────────────────┼────────┼─────────────┤');

  for (const instance of instances) {
    const dataDir = instance.dataDir.length > 39
      ? '...' + instance.dataDir.slice(-36)
      : instance.dataDir;

    console.log(
      `│ ${String(instance.port).padEnd(6)} │ ${dataDir.padEnd(43)} │ ${String(instance.pid).padEnd(6)} │ ${formatUptime(instance.started).padEnd(11)} │`
    );
  }

  console.log('└────────┴─────────────────────────────────────────────┴────────┴─────────────┘');
  console.log(`\nTotal: ${instances.length} instances`);

  const info = portInfo();
  console.log(`Port range: ${info.start}-${info.end} (${info.used}/${info.total} used)\n`);
}

/**
 * Command: url
 */
function cmdUrl() {
  const dataDir = args[1];

  if (!dataDir) {
    console.error('❌ Error: Data directory required');
    console.log('Usage: pglite-server url <dataDir>');
    process.exit(1);
  }

  const instance = findByDataDir(dataDir);

  if (!instance) {
    console.error(`❌ No running instance found for ${dataDir}`);
    process.exit(1);
  }

  console.log(`postgresql://localhost:${instance.port}`);
}

/**
 * Command: health
 */
function cmdHealth() {
  const portIndex = args.indexOf('--port');
  let instance;

  if (portIndex >= 0) {
    const port = parseInt(args[portIndex + 1], 10);
    instance = findByPort(port);
  } else {
    const dataDir = args[1];
    if (!dataDir) {
      console.error('❌ Error: Data directory or --port required');
      console.log('Usage: pglite-server health <dataDir> | --port <number>');
      process.exit(1);
    }
    instance = findByDataDir(dataDir);
  }

  if (!instance) {
    console.error('❌ No running instance found');
    process.exit(1);
  }

  console.log(`\n✅ Instance healthy`);
  console.log(`📍 URL: postgresql://localhost:${instance.port}`);
  console.log(`📁 Data: ${instance.dataDir}`);
  console.log(`🔌 Port: ${instance.port}`);
  console.log(`🆔 PID: ${instance.pid}`);
  console.log(`⏱️  Uptime: ${formatUptime(instance.started)}`);
  console.log(`📊 Version: ${instance.version}\n`);
}

/**
 * Command: info
 */
function cmdInfo() {
  const info = portInfo();

  console.log('\n📊 Port Range Information:');
  console.log(`   Range: ${info.start}-${info.end}`);
  console.log(`   Total: ${info.total} ports`);
  console.log(`   Used: ${info.used} ports`);
  console.log(`   Available: ${info.available} ports`);

  if (info.usedPorts.length > 0) {
    console.log(`   Active ports: ${info.usedPorts.join(', ')}`);
  }

  console.log('');
}

/**
 * Command: cleanup
 */
function cmdCleanup() {
  const cleaned = cleanup();

  if (cleaned === 0) {
    console.log('✅ No stale instances to clean up');
  } else {
    console.log(`✅ Cleaned up ${cleaned} stale instance${cleaned > 1 ? 's' : ''}`);
  }
}

/**
 * Command: router (multi-tenant mode)
 */
async function cmdRouter() {
  // Parse options
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? parseInt(args[portIndex + 1], 10) : 8432;

  const dataIndex = args.indexOf('--data');
  const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : null;
  const memoryMode = dataDir === null;

  const maxIndex = args.indexOf('--max');
  const maxInstances = maxIndex >= 0 ? parseInt(args[maxIndex + 1], 10) : 100;

  const logIndex = args.indexOf('--log');
  const logLevel = logIndex >= 0 ? args[logIndex + 1] : 'info';
  const autoProvision = !args.includes('--no-provision');

  try {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  Starting Multi-Tenant PostgreSQL Router                         ║
╚═══════════════════════════════════════════════════════════════════╝
`);

    const router = await startMultiTenantServer({
      port,
      baseDir: memoryMode ? null : dataDir,
      memoryMode,
      maxInstances,
      logLevel,
      autoProvision
    });

    console.log(`
✅ Multi-tenant router started successfully!

📍 PostgreSQL endpoint: postgresql://localhost:${port}/<database>
📁 Data directory: ${memoryMode ? '(in-memory)' : dataDir}
🎯 Auto-provision: ${autoProvision ? 'enabled' : 'disabled'}
💾 Mode: ${memoryMode ? 'In-memory (ephemeral)' : 'Persistent'}
📊 Max instances: ${maxInstances}

💡 Examples:
   postgresql://localhost:${port}/user123   → ${memoryMode ? 'Creates in-memory database' : `Creates ${dataDir}/user123/`}
   postgresql://localhost:${port}/app456    → ${memoryMode ? 'Creates in-memory database' : `Creates ${dataDir}/app456/`}

Press Ctrl+C to stop
`);

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error(`❌ Failed to start router: ${error.message}`);
    process.exit(1);
  }
}

// Main CLI router
async function main() {
  switch (command) {
    case 'router':
      await cmdRouter();
      break;

    case 'start':
      await cmdStart();
      break;

    case 'stop':
      await cmdStop();
      break;

    case 'list':
      cmdList();
      break;

    case 'url':
      cmdUrl();
      break;

    case 'health':
      cmdHealth();
      break;

    case 'info':
      cmdInfo();
      break;

    case 'cleanup':
      cmdCleanup();
      break;

    case 'help':
    case undefined:
      printHelp();
      break;

    default:
      console.error(`❌ Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`❌ Error: ${error.message}`);
  process.exit(1);
});
