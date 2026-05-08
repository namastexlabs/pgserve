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
import { PostgresManager } from '../src/postgres.js';
import { loadEffectiveConfig as loadAutopgConfig } from '../src/settings-loader.cjs';
import {
  PgserveDaemon,
  stopDaemon,
  resolveControlSocketDir,
  resolveControlSocketPath,
} from '../src/daemon.js';
import { createAdminClient, readAdminDiscovery } from '../src/admin-client.js';
import {
  ensureMetaSchema,
  addAllowedToken,
  revokeAllowedToken,
} from '../src/control-db.js';
import { mintToken } from '../src/tokens.js';
import { audit, AUDIT_EVENTS } from '../src/audit.js';
import { resolveSocketDir, ensureSocketDir } from '../src/lib/socket-dir.js';
import { createLogger } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Global error handlers
process.on('unhandledRejection', (reason, _promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Parse CLI arguments — `pgserve daemon [stop]` is dispatched before the
// classic `pgserve [options]` parser so daemon-mode flags do not collide
// with router flags.
const args = process.argv.slice(2);

if (args[0] === 'daemon') {
  await runDaemonSubcommand(args.slice(1));
}

if (args[0] === 'postmaster') {
  await runPostmasterSubcommand(args.slice(1));
}

/**
 * `pgserve postmaster` — supervises an embedded PostgreSQL postmaster
 * directly (no router, no bun proxy, no daemon control socket).
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 1.
 *
 * The postmaster listens on the canonical Unix socket at
 * `<socketDir>/.s.PGSQL.<port>` AND TCP `<port>` (via postgres' default
 * `listen_addresses = 'localhost'`). Operators connect with either:
 *
 *     psql -h $XDG_RUNTIME_DIR/pgserve         # Unix socket (no -p)
 *     psql -h 127.0.0.1 -p 5432                # canonical TCP
 *
 * This is the entry point pm2 invokes for the `autopg-server` process. The
 * legacy router/foreground mode (`pgserve [options]` without a subcommand)
 * is unchanged and will be removed in Group 2 once the bun proxy is gone.
 */
async function runPostmasterSubcommand(postmasterArgs) {
  const opts = parsePostmasterArgs(postmasterArgs);
  const logger = createLogger({ level: opts.logLevel });

  // Resolve and ensure the socket directory before postgres tries to bind.
  // Surfaces "not writable" / "wrong owner" failures here with a clear
  // diagnostic instead of leaving the operator to chase a libpq error.
  let socketDir;
  try {
    socketDir = ensureSocketDir(opts.socketDir);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const manager = new PostgresManager({
    dataDir: opts.dataDir,
    port: opts.port,
    socketDir,
    useRam: opts.useRam,
    enablePgvector: opts.enablePgvector,
    logger: logger.child({ component: 'postgres' }),
  });

  // Surface unexpected backend death so pm2 can restart us cleanly. Mirrors
  // the daemon-mode contract from PR #49 (issue #45).
  manager.on('backendDiedUnexpectedly', ({ code }) => {
    logger.error(
      { code },
      'pgserve postmaster: postgres backend exited unexpectedly; exiting so the supervisor can restart',
    );
    process.exit(1);
  });

  try {
    await manager.start();
  } catch (err) {
    logger.error({ err: err.message }, 'pgserve postmaster: failed to start');
    process.exit(1);
  }

  logger.info(
    { port: opts.port, socketDir, dataDir: opts.dataDir },
    'pgserve postmaster: ready (Unix socket + TCP)',
  );

  const shutdown = async (signal) => {
    logger.info({ signal }, 'pgserve postmaster: stopping');
    try {
      await manager.stop();
    } catch (err) {
      logger.warn({ err: err.message }, 'pgserve postmaster: error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Park forever; the supervisor decides when to stop us.
  await new Promise(() => {});
}

function parsePostmasterArgs(postmasterArgs) {
  const opts = {
    port: 5432,
    dataDir: null,
    socketDir: undefined, // resolved via resolveSocketDir() if unset
    logLevel: 'info',
    useRam: false,
    enablePgvector: false,
  };
  for (let i = 0; i < postmasterArgs.length; i++) {
    const arg = postmasterArgs[i];
    switch (arg) {
      case '--port':
      case '-p': {
        const raw = postmasterArgs[++i];
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          console.error(`pgserve postmaster: invalid --port "${raw}"`);
          process.exit(1);
        }
        opts.port = parsed;
        break;
      }
      case '--data':
      case '-d':
        opts.dataDir = postmasterArgs[++i];
        break;
      case '--socket-dir':
      case '-k':
        opts.socketDir = postmasterArgs[++i];
        break;
      case '--log':
      case '-l':
        opts.logLevel = postmasterArgs[++i];
        break;
      case '--ram':
        opts.useRam = true;
        break;
      case '--pgvector':
        opts.enablePgvector = true;
        break;
      case '--help':
        console.log(`
pgserve postmaster — direct embedded PostgreSQL supervision (singleton v2.4)

USAGE:
  pgserve postmaster [options]

OPTIONS:
  --port, -p <n>        TCP port (default: 5432)
  --data, -d <path>     Data directory (required for persistence)
  --socket-dir, -k <p>  Unix socket dir (default: $XDG_RUNTIME_DIR/pgserve)
  --log, -l <level>     Log level: error|warn|info|debug (default: info)
  --ram                 Use /dev/shm (Linux only)
  --pgvector            Auto-enable pgvector on new databases
  --help                Show this help

The postmaster binds <socket-dir>/.s.PGSQL.<port> and TCP <port> on
localhost. This entry point is invoked by pm2/systemd-user/launchd; it has
no router, no bun proxy, no daemon control socket.
`);
        process.exit(0);
        // falls through (unreachable)
      default:
        if (arg.startsWith('-')) {
          console.error(`pgserve postmaster: unknown option "${arg}"`);
          process.exit(1);
        }
    }
  }
  if (opts.socketDir === undefined) opts.socketDir = resolveSocketDir();
  return opts;
}

async function runDaemonSubcommand(daemonArgs) {
  if (daemonArgs[0] === 'stop') {
    const result = stopDaemon();
    if (result.stopped) {
      console.log(`pgserve daemon stopped (pid ${result.pid})`);
      process.exit(0);
    }
    if (result.reason === 'no-pid-file') {
      console.error('pgserve daemon: no PID file found — is the daemon running?');
      process.exit(1);
    }
    if (result.reason === 'stale-pid' || result.reason === 'invalid-pid-file') {
      console.log(`pgserve daemon: cleaned up stale lock (pid ${result.pid ?? '?'})`);
      process.exit(0);
    }
    if (result.reason === 'timeout') {
      console.error(`pgserve daemon: pid ${result.pid} did not exit within timeout`);
      process.exit(1);
    }
    console.error(`pgserve daemon stop: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    process.exit(1);
  }

  if (daemonArgs[0] === 'issue-token') {
    await runIssueTokenSubcommand(daemonArgs.slice(1));
    return;
  }
  if (daemonArgs[0] === 'revoke-token') {
    await runRevokeTokenSubcommand(daemonArgs.slice(1));
    return;
  }

  // `pgserve daemon` (long-running)
  const opts = parseDaemonArgs(daemonArgs);
  const daemon = new PgserveDaemon(opts);

  // When the postgres backend dies on us (SIGKILL, OOM, segfault, anything
  // other than a clean stop()), exit non-zero so a process supervisor can
  // restart the daemon cleanly. Without this, the wrapper sat alive in
  // epoll_wait while postgres was dead, and clients got "control.sock
  // accepts but never replies" — pgserve#45.
  daemon.on('backendDiedUnexpectedly', ({ code }) => {
    console.error(
      `pgserve daemon: postgres backend exited unexpectedly (code=${code}); ` +
      `the wrapper is exiting so a process supervisor can restart it.`
    );
    process.exit(1);
  });

  try {
    await daemon.start();
  } catch (err) {
    if (err.code === 'EALREADYRUNNING') {
      console.error(`pgserve daemon: already running, pid ${err.pid}`);
      process.exit(1);
    }
    console.error('pgserve daemon: failed to start:', err.message);
    process.exit(1);
  }
  const dir = resolveControlSocketDir();
  console.log(`
pgserve daemon — singleton mode

  Control socket: ${resolveControlSocketPath(dir)}
  PID lock:       ${path.join(dir, 'pgserve.pid')}
  PG socket:      ${daemon.pgManager.getSocketPath() || '(TCP fallback)'}

  Connect:        psql 'host=${dir} dbname=mydb'

  Press Ctrl+C or send SIGTERM to stop.
`);

  // Daemon installs its own SIGTERM/SIGINT handlers; just wait forever.
  await new Promise(() => {});
}

function parseDaemonArgs(daemonArgs) {
  const opts = {
    baseDir: null,
    useRam: false,
    logLevel: 'info',
    autoProvision: true,
    tcpListens: [],
    enablePgvector: false,
    maxConnections: null,
  };
  for (let i = 0; i < daemonArgs.length; i++) {
    const arg = daemonArgs[i];
    switch (arg) {
      case '--data':
      case '-d':
        opts.baseDir = daemonArgs[++i];
        break;
      case '--ram':
        opts.useRam = true;
        break;
      case '--log':
      case '-l':
        opts.logLevel = daemonArgs[++i];
        break;
      case '--no-provision':
        opts.autoProvision = false;
        break;
      case '--listen':
        opts.tcpListens.push(daemonArgs[++i]);
        break;
      case '--pgvector':
        opts.enablePgvector = true;
        break;
      case '--max-connections': {
        // Accept the same flag the foreground/router mode takes so callers
        // (genie's `getOrStartDaemon`, anything that spawns `pgserve daemon`
        // with a tuned cap) can override the postmaster's `max_connections`.
        // The `PgserveDaemon` constructor already honors `options.maxConnections`
        // (see src/daemon.js — defaults to 1000); we just plumb it through.
        const raw = daemonArgs[++i];
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          console.error(`--max-connections: expected a positive integer, got "${raw}"`);
          process.exit(1);
        }
        opts.maxConnections = parsed;
        break;
      }
      case '--help':
        console.log(`
pgserve daemon — singleton control-socket mode

USAGE:
  pgserve daemon [options]
  pgserve daemon stop
  pgserve daemon issue-token --fingerprint <hex>
  pgserve daemon revoke-token <id>

OPTIONS:
  --data <path>          Persistent data directory (default: in-memory)
  --ram                  Use /dev/shm storage (Linux only)
  --log <level>          Log level: error|warn|info|debug (default: info)
  --no-provision         Disable auto-provisioning of databases
  --listen [host:]port   Bind opt-in TCP listener (repeatable)
  --pgvector             Auto-enable pgvector extension on new databases
  --max-connections <n>  Override the postmaster's max_connections (default: 1000)
  --help                 Show this help

The daemon binds $XDG_RUNTIME_DIR/pgserve/control.sock (fallback /tmp/pgserve/control.sock).
A second invocation while the first is running exits with "already running".

TCP peers (--listen) MUST authenticate via libpq application_name shaped
"?fingerprint=<12hex>&token=<bearer>". Issue tokens with
"pgserve daemon issue-token --fingerprint <hex>". Revoke with
"pgserve daemon revoke-token <id>".
`);
        process.exit(0);
        // falls through (unreachable)
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown daemon option: ${arg}`);
          process.exit(1);
        }
    }
  }
  return opts;
}

async function runIssueTokenSubcommand(args) {
  let fingerprint = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fingerprint') fingerprint = args[++i];
    else if (arg === '--help') {
      console.log(`
pgserve daemon issue-token --fingerprint <12hex>

Issues a fresh bearer token for an existing fingerprint. Prints the token
to stdout exactly once; only the sha256 hash is persisted. Use the printed
value in libpq application_name shaped "?fingerprint=<hex>&token=<bearer>".
`);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  if (!fingerprint || !/^[0-9a-f]{12}$/.test(fingerprint)) {
    console.error('issue-token: --fingerprint <12hex> required');
    process.exit(1);
  }

  let admin;
  try {
    const dir = resolveControlSocketDir();
    const disc = readAdminDiscovery(dir);
    admin = await createAdminClient({ socketDir: disc.socketDir, port: disc.port });
  } catch (err) {
    console.error('issue-token: cannot reach running daemon admin socket:', err.message);
    console.error('Hint: start the daemon first with `pgserve daemon`.');
    process.exit(1);
  }

  try {
    await ensureMetaSchema(admin);
    const { id, cleartext, hash } = mintToken();
    const result = await addAllowedToken(admin, {
      fingerprint,
      tokenId: id,
      tokenHash: hash,
    });
    audit(AUDIT_EVENTS.TCP_TOKEN_ISSUED, {
      fingerprint,
      token_id: id,
      database: result.databaseName,
    });
    console.log('Token issued. Save the bearer value below — it will not be shown again:');
    console.log('');
    console.log(`  id:          ${id}`);
    console.log(`  fingerprint: ${fingerprint}`);
    console.log(`  database:    ${result.databaseName}`);
    console.log(`  token:       ${cleartext}`);
    console.log('');
    console.log('Use as libpq application_name:');
    console.log(`  application_name='?fingerprint=${fingerprint}&token=${cleartext}'`);
    process.exit(0);
  } catch (err) {
    if (err.code === 'EUNKNOWNFINGERPRINT') {
      console.error(`issue-token: fingerprint ${fingerprint} not provisioned yet.`);
      console.error('Connect once via Unix socket so pgserve creates the database first.');
      process.exit(2);
    }
    console.error('issue-token failed:', err.message);
    process.exit(1);
  } finally {
    try { await admin.end(); } catch { /* swallow */ }
  }
}

async function runRevokeTokenSubcommand(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: pgserve daemon revoke-token <id>');
    process.exit(args.length === 0 ? 1 : 0);
  }
  const tokenId = args[0];

  let admin;
  try {
    const dir = resolveControlSocketDir();
    const disc = readAdminDiscovery(dir);
    admin = await createAdminClient({ socketDir: disc.socketDir, port: disc.port });
  } catch (err) {
    console.error('revoke-token: cannot reach running daemon admin socket:', err.message);
    process.exit(1);
  }

  try {
    const affected = await revokeAllowedToken(admin, tokenId);
    if (affected === 0) {
      console.error(`revoke-token: no token with id ${tokenId} found`);
      process.exit(2);
    }
    console.log(`Token ${tokenId} revoked (affected ${affected} row${affected === 1 ? '' : 's'})`);
    process.exit(0);
  } catch (err) {
    console.error('revoke-token failed:', err.message);
    process.exit(1);
  } finally {
    try { await admin.end(); } catch { /* swallow */ }
  }
}

/**
 * Print usage help
 */
function printHelp() {
  console.log(`
pgserve - Embedded PostgreSQL Server
=====================================

True concurrent connections, zero config, auto-provision databases.

USAGE:
  pgserve [options]                 # foreground server
  pgserve install [--port N]        # register under pm2 (idempotent)
  pgserve serve                     # alias for "pgserve daemon"
  pgserve status [--json]           # report pm2 + config state
  pgserve url                       # print canonical postgres:// URL
  pgserve port                      # print canonical port
  pgserve uninstall                 # remove from pm2 (keep data)
  pgserve daemon [stop]             # singleton daemon (Unix socket)

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
  --pgvector         Auto-enable pgvector extension on new databases
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
 * Pull daemon options from ~/.autopg/settings.json (with env overlay).
 * Returns a partial options patch — only keys that are present in the
 * settings file or env override the hardcoded defaults. CLI flags layer
 * on top of this in parseArgs().
 *
 * Failures (missing file, bad JSON) fall through to defaults silently —
 * the daemon must remain runnable on a brand-new install before
 * `autopg config init` has been called.
 */
function loadSettingsOverlay() {
  try {
    const cpuCount = os.cpus().length;
    const isWindows = os.platform() === 'win32';
    const { settings } = loadAutopgConfig();
    const s = settings.server || {};
    const r = settings.runtime || {};
    const sy = settings.sync || {};
    const pg = settings.postgres || {};
    const overlay = {};
    if (typeof s.port === 'number') overlay.port = s.port;
    if (typeof s.host === 'string' && s.host) overlay.host = s.host;
    if (typeof r.dataDir === 'string' && r.dataDir) overlay.dataDir = r.dataDir;
    if (typeof r.ramMode === 'boolean') overlay.useRam = r.ramMode;
    if (typeof r.logLevel === 'string' && r.logLevel) overlay.logLevel = r.logLevel;
    if (typeof r.autoProvision === 'boolean') overlay.autoProvision = r.autoProvision;
    if (typeof r.cluster === 'string') {
      overlay.cluster = r.cluster === 'auto'
        ? (cpuCount > 1 && !isWindows)
        : r.cluster === 'on';
    }
    if (typeof r.workers === 'number' && r.workers > 0) overlay.workers = r.workers;
    if (typeof r.statsDashboard === 'boolean') overlay.showStats = r.statsDashboard;
    if (typeof r.enablePgvector === 'boolean') overlay.enablePgvector = r.enablePgvector;
    if (sy.enabled && typeof sy.url === 'string' && sy.url) overlay.syncTo = sy.url;
    if (sy.enabled && typeof sy.databases === 'string' && sy.databases) overlay.syncDatabases = sy.databases;
    // pgserve-side connection cap mirrors the postgres GUC unless the user
    // has explicitly diverged via CLI flag (handled in parseArgs).
    if (typeof pg.max_connections === 'number') overlay.maxConnections = pg.max_connections;
    return overlay;
  } catch {
    // First run, no settings.json yet, or file parse error. Hardcoded
    // defaults still produce a working daemon — nothing to do here.
    return {};
  }
}

/**
 * Parse command line arguments
 *
 * Precedence (lowest → highest):
 *   1. hardcoded defaults
 *   2. ~/.autopg/settings.json (with env overlay via loadEffectiveConfig)
 *   3. CLI flags  ← explicit user intent always wins
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
    maxConnections: 1000, // Max concurrent connections (high default for multi-tenant)
    enablePgvector: false // Auto-enable pgvector extension on new databases
  };

  // Layer settings.json + env on top of defaults. CLI flags below win.
  Object.assign(options, loadSettingsOverlay());

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

      case '--pgvector':
        options.enablePgvector = true;
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
        maxConnections: options.maxConnections,
        enablePgvector: options.enablePgvector
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
  pgvector:    ${options.enablePgvector ? 'Enabled (auto-installed on new DBs)' : 'Disabled (use --pgvector to enable)'}

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
        maxConnections: options.maxConnections,
        enablePgvector: options.enablePgvector
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
  pgvector:    ${options.enablePgvector ? 'Enabled (auto-installed on new DBs)' : 'Disabled (use --pgvector to enable)'}
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
