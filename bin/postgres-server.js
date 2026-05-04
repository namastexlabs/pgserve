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
import { loadEffectiveConfig as loadAutopgConfig } from '../src/settings-loader.cjs';
import {
  PgserveDaemon,
  stopDaemon,
  resolveControlSocketDir,
} from '../src/daemon.js';
import { createAdminClient, readAdminDiscovery } from '../src/admin-client.js';
import {
  ensureMetaSchema,
  addAllowedToken,
  revokeAllowedToken,
} from '../src/control-db.js';
import { mintToken } from '../src/tokens.js';
import { audit, AUDIT_EVENTS } from '../src/audit.js';

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

// `serve` is the install.sh-side alias for the long-running daemon, and
// the form pm2 invokes when Group 11 registers the binary as
// `autopg serve`. Rewrite to `daemon` so the existing daemon dispatcher
// owns the rest.
if (args[0] === 'serve') args[0] = 'daemon';

if (args[0] === 'daemon') {
  await runDaemonSubcommand(args.slice(1));
}

// `autopg install [--non-interactive]` — Group 11, autopg-distribution-cutover.
// The bun-compiled binary is invoked by install.sh after tarball verification:
//   exec "${dest}/autopg/autopg" install --non-interactive
// Hand the rest of the CLI surface off to src/cli/install.js, which owns
// pm2 register, ~/.local/bin symlink, rc-file PATH wiring, completions,
// and first-run hooks. Stays before the classic `pgserve [options]` parser
// so the install flags don't collide with the router.
if (args[0] === 'install') {
  const mod = await import('../src/cli/install.js');
  const code = await mod.install(args.slice(1), {});
  process.exit(typeof code === 'number' ? code : 0);
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
  const pgSocketPath = daemon.pgManager.getSocketPath() || '(TCP fallback)';
  console.log(`
pgserve daemon — singleton mode (post-cutover)

  PID lock:       ${path.join(dir, 'pgserve.pid')}
  PG socket:      ${pgSocketPath}

  Connect:        psql 'host=${daemon.pgManager.socketDir || dir} dbname=mydb'

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
        // Deprecated post-cutover — TCP gateway was deleted with the
        // wrapper-proxy modules. Consume the argument to preserve flag
        // shape but otherwise no-op so legacy callers don't crash.
        i++;
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
pgserve daemon — singleton mode (post-cutover)

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
  --listen [host:]port   (deprecated, ignored — TCP gateway removed in autopg cutover)
  --pgvector             Auto-enable pgvector extension on new databases
  --max-connections <n>  Override the postmaster's max_connections (default: 1000)
  --help                 Show this help

The daemon owns the PostgreSQL backend under a singleton PID lock at
$XDG_RUNTIME_DIR/pgserve/pgserve.pid (fallback /tmp/pgserve/pgserve.pid).
Apps connect to PG's native Unix socket (printed at boot) using a per-app
SCRAM credential delivered via ~/.autopg/<app>.env.
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

  // autopg cutover (Group 4): the foreground multi-tenant + cluster
  // routers were deleted along with the wrapper-proxy code path that
  // caused issue #54. Use `pgserve daemon` (singleton mode) for the
  // surviving entry point, or the `autopg` binary once the curl
  // installer ships.
  console.error(`
pgserve foreground / cluster mode has been removed in the autopg
distribution cutover. The wrapper-proxy code path that backed it
(src/router.js, src/cluster.js, src/pg-wire.js, …) is gone — apps now
connect directly to PostgreSQL using a per-app SCRAM credential
delivered via ~/.autopg/<app>.env.

Migration path:
  - For pm2-managed servers, run \`pgserve daemon\` (singleton mode).
  - For new installs, use the curl-installed \`autopg\` binary:
      curl -fsSL https://get.automagik.dev/autopg | bash

(arguments parsed: ${JSON.stringify({
    cluster: options.cluster,
    port: options.port,
    host: options.host,
    dataDir: options.dataDir,
    memoryMode,
    storageType,
  })})
`);
  process.exit(2);
}

main();
