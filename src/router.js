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
 *
 * PERFORMANCE: Uses Bun.listen() and Bun.connect() for 2-3x throughput improvement
 */

import { PostgresManager } from './postgres.js';
import { SyncManager } from './sync.js';
import { RestoreManager } from './restore.js';
import { Dashboard } from './dashboard.js';
import { extractDatabaseName } from './protocol.js';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

// PostgreSQL protocol constants
const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
const GSSAPI_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

/**
 * Attempt to write a pending buffer to a target socket.
 * Returns remaining unwritten bytes, or null if fully flushed.
 */
function flushPending(target, pending) {
  const written = target.write(pending);
  if (written === pending.byteLength) return null;
  if (written === 0) return pending;
  return pending.subarray(written);
}

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
      useRam: options.useRam,  // Use /dev/shm for true RAM storage (Linux only)
      enablePgvector: options.enablePgvector  // Auto-enable pgvector extension on new databases
    });

    // TCP server
    this.server = null;
    this.connections = new Set();

    // Performance: Reduce event listener overhead
    this.setMaxListeners(this.maxConnections + 10);
  }

  /**
   * Socket state storage for Bun TCP handler model
   * Maps client socket to its state (buffer, pgSocket, dbName, etc.)
   */
  socketState = new WeakMap();

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

    // Create TCP server using Bun.listen() for 2-3x throughput
    const router = this;
    this.server = Bun.listen({
      hostname: this.host,
      port: this.port,
      socket: {
        // Called when data arrives on client socket
        data(socket, data) {
          router.handleSocketData(socket, data);
        },
        // Called when client connects
        open(socket) {
          router.handleSocketOpen(socket);
        },
        // Called when client disconnects
        close(socket) {
          router.handleSocketClose(socket);
        },
        // Called on socket error
        error(socket, error) {
          router.handleSocketError(socket, error);
        },
        // Called when client socket is ready to receive more data
        drain(socket) {
          const state = router.socketState.get(socket);
          if (!state) return;
          // Flush any pending PG→Client data
          if (state.pendingToClient) {
            state.pendingToClient = flushPending(socket, state.pendingToClient);
          }
          // If fully flushed, resume reading from PostgreSQL
          if (!state.pendingToClient && state.pgSocket) {
            state.pgSocket.resume();
          }
        }
      }
    });

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
  }

  /**
   * Handle socket open (Bun TCP handler)
   */
  handleSocketOpen(socket) {
    // Initialize socket state
    this.socketState.set(socket, {
      buffer: null,
      pgSocket: null,
      dbName: null,
      handshakeComplete: false,
      pendingToPg: null,
      pendingToClient: null
    });

    // Track connection
    this.connections.add(socket);
  }

  /**
   * Handle socket data (Bun TCP handler)
   * Handles both handshake and proxying phases
   */
  handleSocketData(socket, data) {
    const state = this.socketState.get(socket);
    if (!state) return;

    // If handshake complete, forward to PostgreSQL
    if (state.handshakeComplete && state.pgSocket) {
      // If there's already pending data, append to it
      if (state.pendingToPg) {
        state.pendingToPg = Buffer.concat([state.pendingToPg, data]);
        return;
      }
      const written = state.pgSocket.write(data);
      if (written < data.byteLength) {
        // Partial write — buffer remainder and pause client
        state.pendingToPg = written === 0 ? Buffer.from(data) : Buffer.from(data.subarray(written));
        socket.pause();
      }
      return;
    }

    // Buffer data for startup message parsing
    if (state.buffer) {
      state.buffer = Buffer.concat([state.buffer, data]);
    } else {
      state.buffer = Buffer.from(data);
    }

    // Try to parse startup message
    this.processStartupMessage(socket, state);
  }

  /**
   * Process PostgreSQL startup message and establish proxy connection
   */
  async processStartupMessage(socket, state) {
    const buffer = state.buffer;
    if (!buffer || buffer.length < 8) return; // Need at least length + protocol

    // Read message length (first 4 bytes, big-endian)
    const messageLength = buffer.readUInt32BE(0);
    if (buffer.length < messageLength) return; // Wait for complete message

    // Read protocol version or request code (next 4 bytes)
    const code = buffer.readUInt32BE(4);

    // Handle SSL/GSSAPI/Cancel requests
    if (code === SSL_REQUEST_CODE || code === GSSAPI_REQUEST_CODE) {
      // Reject SSL/GSSAPI - send 'N' (not supported)
      socket.write(Buffer.from('N'));
      // Remove this request from buffer, wait for real startup
      state.buffer = buffer.length > messageLength ? buffer.subarray(messageLength) : null;
      return;
    }

    if (code === CANCEL_REQUEST_CODE) {
      // Cancel request - just close connection
      socket.end();
      return;
    }

    // Must be protocol version 3.0
    if (code !== PROTOCOL_VERSION_3) {
      this.logger.warn({ code }, 'Unsupported protocol version');
      socket.end();
      return;
    }

    // Extract database name from startup message
    const startupMessage = buffer.subarray(0, messageLength);
    const dbName = extractDatabaseName(startupMessage);
    state.dbName = dbName;

    try {
      // Auto-provision database if needed
      if (this.autoProvision) {
        await this.pgManager.createDatabase(dbName);
      }

      // Connect to real PostgreSQL using Bun.connect()
      const socketPath = this.pgManager.getSocketPath();
      const router = this;

      // Shared handler for pgSocket (used by both unix and TCP paths)
      const pgHandler = {
        data(_pgSocket, pgData) {
          // Forward PostgreSQL response to client with backpressure
          if (state.pendingToClient) {
            state.pendingToClient = Buffer.concat([state.pendingToClient, pgData]);
            return;
          }
          const written = socket.write(pgData);
          if (written < pgData.byteLength) {
            state.pendingToClient = written === 0 ? Buffer.from(pgData) : Buffer.from(pgData.subarray(written));
            _pgSocket.pause();
          }
        },
        open(pgSocket) {
          pgSocket.write(startupMessage);
          state.handshakeComplete = true;
        },
        close(_pgSocket) {
          socket.end();
        },
        error(_pgSocket, error) {
          router.logger.error({ dbName, err: error }, 'PostgreSQL socket error');
          socket.end();
        },
        drain(_pgSocket) {
          // Flush any pending Client→PG data
          if (state.pendingToPg) {
            state.pendingToPg = flushPending(_pgSocket, state.pendingToPg);
          }
          // If fully flushed, resume reading from client
          if (!state.pendingToPg) {
            socket.resume();
          }
        }
      };

      if (socketPath) {
        state.pgSocket = await Bun.connect({ unix: socketPath, socket: pgHandler });
      } else {
        state.pgSocket = await Bun.connect({ hostname: '127.0.0.1', port: this.pgPort, socket: pgHandler });
      }

      this.emit('connection', { dbName, socket });
    } catch (error) {
      this.logger.error({ dbName, err: error }, 'Connection error');
      socket.end();
      this.emit('connection-error', { error, dbName });
    }
  }

  /**
   * Handle socket close (Bun TCP handler)
   */
  handleSocketClose(socket) {
    const state = this.socketState.get(socket);
    if (state) {
      state.pendingToPg = null;
      state.pendingToClient = null;
      if (state.pgSocket) state.pgSocket.end();
    }
    this.connections.delete(socket);
    this.socketState.delete(socket);
  }

  /**
   * Handle socket error (Bun TCP handler)
   */
  handleSocketError(socket, error) {
    const state = this.socketState.get(socket);
    // Only log non-connection-reset errors
    if (error.code !== 'ECONNRESET') {
      this.logger.error({ err: error, dbName: state?.dbName }, 'Socket error');
    }
    if (state) {
      state.pendingToPg = null;
      state.pendingToClient = null;
      if (state.pgSocket) state.pgSocket.end();
    }
    this.connections.delete(socket);
    this.socketState.delete(socket);
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

    // Close TCP server (Bun.listen returns a server with stop() method)
    if (this.server) {
      this.server.stop();
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
