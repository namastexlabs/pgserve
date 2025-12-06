/**
 * Multi-Tenant Router (TCP Proxy to Embedded PostgreSQL)
 *
 * Single TCP server that routes connections to an embedded PostgreSQL instance.
 * Extracts database name from PostgreSQL startup message, auto-creates database,
 * then proxies the connection to real PostgreSQL.
 *
 * Features:
 * - TRUE concurrent connections (native PostgreSQL)
 * - Auto-provision databases on first connection
 * - Zero configuration required
 * - Memory mode (default) or persistent storage
 */

import net from 'net';
import { PostgresManager } from './postgres.js';
import { SyncManager } from './sync.js';
import { RestoreManager } from './restore.js';
import { Dashboard } from './dashboard.js';
import { extractDatabaseNameFromSocket } from './protocol.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

/**
 * Multi-Tenant Router Server
 */
export class MultiTenantRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8432;
    this.host = options.host || '127.0.0.1';
    this.baseDir = options.baseDir || null; // null = memory mode
    this.memoryMode = !options.baseDir;
    this.maxConnections = options.maxConnections || 1000;
    this.autoProvision = options.autoProvision !== false;

    // Internal PostgreSQL port (different from router port)
    this.pgPort = options.pgPort || (this.port + 1000);

    // Pino logger (ultra-fast structured logging)
    const logLevel = options.logLevel || 'info';
    this.logger = options.logger || createLogger({ level: logLevel });

    // Sync options (async replication to real PostgreSQL)
    this.syncTo = options.syncTo || null;
    this.syncDatabases = options.syncDatabases
      ? options.syncDatabases.split(',').map(s => s.trim())
      : [];
    this.syncManager = null;

    // PostgreSQL manager (with sync flag if needed)
    this.pgManager = new PostgresManager({
      dataDir: this.baseDir,
      port: this.pgPort,
      logger: this.logger.child({ component: 'postgres' }),
      syncEnabled: !!this.syncTo,  // Enable logical replication if sync is configured
      useRam: options.useRam  // Use /dev/shm for true RAM storage (Linux only)
    });

    // TCP server
    this.server = null;
    this.connections = new Set();

    // Performance: Reduce event listener overhead
    this.setMaxListeners(this.maxConnections + 10);
  }

  /**
   * Optimize TCP socket for PostgreSQL wire protocol
   * @param {net.Socket} socket - TCP socket to optimize
   */
  optimizeSocket(socket) {
    // Disable Nagle's algorithm for lower latency
    socket.setNoDelay(true);

    // Enable TCP keepalive (detect dead connections)
    socket.setKeepAlive(true, 60000); // 60s initial delay

    // Prevent socket timeout during long-running queries
    socket.setTimeout(0);
  }

  /**
   * Start multi-tenant router
   */
  async start() {
    // Initialize dashboard for informative CLI output
    const dashboard = new Dashboard();
    dashboard.showHeader({
      port: this.port,
      host: this.host,
      memoryMode: this.memoryMode,
      syncTo: this.syncTo
    });

    // Start PostgreSQL first
    dashboard.stage('PostgreSQL binaries resolved');
    await this.pgManager.start();
    dashboard.stage('PostgreSQL started');

    // Automatic restore from external PostgreSQL (if sync configured)
    // This runs BEFORE SyncManager to restore data before enabling outbound sync
    if (this.syncTo) {
      const restoreManager = new RestoreManager({
        sourceUrl: this.syncTo,
        patterns: this.syncDatabases,
        targetPort: this.pgPort,
        targetSocketPath: this.pgManager.getSocketPath(),
        logger: this.logger.child({ component: 'restore' }),
        onProgress: (metrics) => dashboard.updateRestore(metrics)
      });

      // Start restore progress display
      dashboard.startRestore(restoreManager.totalDatabases || 1);

      const restoreResult = await restoreManager.restore(this.pgManager);

      if (restoreResult.success) {
        dashboard.completeRestore(restoreResult.metrics);
        this.logger.info({
          databases: restoreResult.metrics.databasesRestored,
          tables: restoreResult.metrics.tablesRestored,
          rows: restoreResult.metrics.rowsRestored,
          bytes: restoreResult.metrics.bytesTransferred,
          durationMs: restoreResult.metrics.endTime - restoreResult.metrics.startTime
        }, 'Restored from external PostgreSQL');
      } else if (restoreResult.skipped) {
        // No progress to complete - was skipped
      } else {
        dashboard.cleanup();
        this.logger.warn({ error: restoreResult.error }, 'Restore failed (continuing without restored data)');
      }
    }

    // Initialize SyncManager if configured (async replication)
    if (this.syncTo) {
      this.syncManager = new SyncManager({
        targetUrl: this.syncTo,
        databases: this.syncDatabases,
        sourcePort: this.pgPort,
        sourceSocketPath: this.pgManager.getSocketPath(),
        logLevel: this.logger.level
      });

      // Wire SyncManager to PostgresManager for database creation hooks
      this.pgManager.setSyncManager(this.syncManager);

      // Initialize sync connections (non-blocking, runs in background)
      this.syncManager.initialize(this.pgManager)
        .then(() => {
          dashboard.stage('Sync manager initialized');
          this.logger.info('Sync manager initialized');
        })
        .catch(err => this.logger.warn({ err: err.message }, 'Sync manager initialization failed (non-fatal)'));
    }

    return new Promise((resolve, _reject) => {
      // Create TCP server
      this.server = net.createServer({
        allowHalfOpen: false,
        pauseOnConnect: true
      }, async (socket) => {
        await this.handleConnection(socket);
      });

      // Set max connections
      this.server.maxConnections = this.maxConnections;

      // Error handling
      this.server.on('error', (error) => {
        this.logger.error({ err: error }, 'Server error');
        this.emit('error', error);
      });

      // Start listening
      this.server.listen(this.port, this.host, () => {
        const socketPath = this.pgManager.getSocketPath();

        dashboard.stage('TCP server listening');
        dashboard.showReady({ port: this.port, host: this.host });

        this.logger.info({
          host: this.host,
          port: this.port,
          pgPort: this.pgPort,
          pgSocketPath: socketPath || '(TCP)',
          baseDir: this.memoryMode ? '(in-memory)' : this.baseDir,
          memoryMode: this.memoryMode,
          autoProvision: this.autoProvision,
          maxConnections: this.maxConnections
        }, 'Multi-tenant router started');

        this.emit('listening');
        resolve();
      });
    });
  }

  /**
   * Handle incoming connection (TCP Proxy)
   * OPTIMIZED: Removed hot path logging for performance
   */
  async handleConnection(socket) {
    // Track connection
    this.connections.add(socket);

    // Optimize socket BEFORE any I/O
    this.optimizeSocket(socket);

    let dbName = null;
    let pgSocket = null;

    try {
      // Extract database name from PostgreSQL handshake
      const { dbName: extractedDbName, buffered } = await extractDatabaseNameFromSocket(socket);
      dbName = extractedDbName;

      // Auto-provision database if needed
      if (this.autoProvision) {
        await this.pgManager.createDatabase(dbName);
      }

      // Connect to real PostgreSQL (prefer Unix socket for speed)
      const socketPath = this.pgManager.getSocketPath();
      if (socketPath) {
        // Unix socket connection (Linux/macOS) - ~30% faster than TCP
        pgSocket = net.connect({ path: socketPath });
      } else {
        // TCP fallback (Windows)
        pgSocket = net.connect({ host: '127.0.0.1', port: this.pgPort });
      }

      // Wait for PostgreSQL connection
      await new Promise((resolve, reject) => {
        pgSocket.once('connect', resolve);
        pgSocket.once('error', reject);
      });

      this.optimizeSocket(pgSocket);

      // Send the buffered startup message to PostgreSQL
      pgSocket.write(buffered);

      // Resume client socket (was paused on connect)
      socket.resume();

      // Bidirectional pipe (TRUE proxy)
      socket.pipe(pgSocket);
      pgSocket.pipe(socket);

      // Handle cleanup - optimized: single handler, no logging in hot path
      const cleanup = () => {
        this.connections.delete(socket);
        if (pgSocket && !pgSocket.destroyed) pgSocket.destroy();
        if (socket && !socket.destroyed) socket.destroy();
      };

      socket.once('close', cleanup);
      socket.once('error', cleanup);
      pgSocket.once('close', () => {
        if (socket && !socket.destroyed) socket.destroy();
      });
      pgSocket.once('error', cleanup);

      this.emit('connection', { dbName, socket });
    } catch (error) {
      // Only log actual errors
      this.logger.error({ dbName, err: error }, 'Connection error');

      // Cleanup
      if (pgSocket && !pgSocket.destroyed) pgSocket.destroy();
      socket.destroy();
      this.connections.delete(socket);
      this.emit('connection-error', { error, dbName });
    }
  }

  /**
   * Stop router (graceful shutdown)
   */
  async stop() {
    this.logger.info('Stopping multi-tenant router');

    // Close all connections gracefully
    const activeConns = this.connections.size;
    for (const socket of this.connections) {
      socket.end();
    }
    this.connections.clear();

    // Close TCP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }

    // Stop SyncManager first (before PostgreSQL)
    if (this.syncManager) {
      await this.syncManager.stop();
    }

    // Stop PostgreSQL
    await this.pgManager.stop();

    this.logger.info({
      activeConnections: activeConns
    }, 'Router stopped');

    this.emit('stopped');
  }

  /**
   * Get router stats
   */
  getStats() {
    return {
      port: this.port,
      host: this.host,
      pgPort: this.pgPort,
      activeConnections: this.connections.size,
      postgres: this.pgManager.getStats()
    };
  }

  /**
   * List all databases
   */
  listDatabases() {
    return this.pgManager.getStats().databases;
  }
}

/**
 * Start multi-tenant router (convenience function)
 */
export async function startMultiTenantServer(options = {}) {
  const router = new MultiTenantRouter(options);
  await router.start();
  return router;
}
