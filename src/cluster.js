/**
 * Cluster Mode for pgserve
 *
 * Architecture:
 * - PRIMARY process: Runs single embedded PostgreSQL instance
 * - WORKER processes: Only run TCP routing to PRIMARY's PostgreSQL
 *
 * This enables multi-core scaling (3-5x throughput on multi-core systems)
 * while maintaining a single PostgreSQL instance.
 */

import cluster from 'cluster';
import os from 'os';
import { SQL } from 'bun';
import { createLogger } from './logger.js';
import { PostgresManager } from './postgres.js';
import { extractDatabaseName } from './protocol.js';
import { EventEmitter } from 'events';

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

// Stats collection constants
const WORKER_STATS_TIMEOUT_MS = 10000; // Worker stats older than this are considered stale
const WORKER_STATS_REPORT_INTERVAL_MS = 4000; // How often workers report stats to primary

/**
 * ClusterRouter - Lightweight TCP router for worker processes
 * Does NOT start PostgreSQL - connects to PRIMARY's PostgreSQL via Unix socket
 */
class ClusterRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8432;
    this.host = options.host || '127.0.0.1';
    this.pgSocketPath = options.pgSocketPath; // From PRIMARY
    this.pgPort = options.pgPort;
    this.pgUser = options.pgUser || 'postgres';
    this.pgPassword = options.pgPassword || 'postgres';
    this.autoProvision = options.autoProvision !== false;
    this.maxConnections = options.maxConnections || 1000;
    this.enablePgvector = options.enablePgvector || false;

    this.logger = createLogger({ level: options.logLevel || 'info' });
    this.sql = null;  // Bun.sql for admin queries
    this.server = null;
    this.connections = new Set();
    this.setMaxListeners(this.maxConnections + 10);

    // Connection stats tracking for IPC reporting
    this.connectionStats = {
      totalConnected: 0,
      totalDisconnected: 0
    };
  }

  /**
   * Socket state storage for Bun TCP handler model
   */
  socketState = new WeakMap();

  async start() {
    // Admin connection for auto-provisioning databases (Bun.sql)
    if (this.autoProvision) {
      // Bun.sql uses TCP connections - Unix sockets not directly supported
      // This is fine for admin queries (low volume, local connection)
      this.sql = new SQL({
        hostname: '127.0.0.1',
        port: this.pgPort,
        database: 'postgres',
        username: this.pgUser,
        password: this.pgPassword,
        max: 2,  // Small pool for admin queries
        idleTimeout: 30,
      });
    }

    // Create TCP server using Bun.listen() for 2-3x throughput
    const router = this;
    const isWindows = os.platform() === 'win32';
    this.server = Bun.listen({
      hostname: this.host,
      port: this.port,
      reusePort: !isWindows,  // SO_REUSEPORT for multi-worker port sharing (Linux/macOS only)
      socket: {
        data(socket, data) {
          router.handleSocketData(socket, data);
        },
        open(socket) {
          router.handleSocketOpen(socket);
        },
        close(socket) {
          router.handleSocketClose(socket);
        },
        error(socket, error) {
          router.handleSocketError(socket, error);
        },
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

    // Verify port actually bound (detect silent failures on Windows)
    if (!this.server || !this.server.port) {
      throw new Error(`Failed to bind to port ${this.port} - reusePort may not be supported on this platform`);
    }

    this.emit('listening');
  }

  async createDatabase(dbName) {
    if (!this.autoProvision || !this.sql) return;

    try {
      // Bun.sql uses tagged template literals for parameterized queries
      const result = await this.sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;

      if (result.length === 0) {
        // Use sql() helper for safe identifier escaping (like CREATE DATABASE)
        await this.sql.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);

        // Auto-enable pgvector extension if configured
        if (this.enablePgvector) {
          await this.enablePgvectorExtension(dbName);
        }
      }
    } catch (error) {
      // Ignore "already exists" (race condition between workers)
      if (!error.message?.includes('already exists')) {
        this.logger.error({ database: dbName, err: error }, 'Failed to create database');
      }
    }
  }

  /**
   * Enable pgvector extension on a database
   * Creates a temporary connection to the specific database to run CREATE EXTENSION
   * @param {string} dbName - Database name to enable pgvector on
   */
  async enablePgvectorExtension(dbName) {
    let dbPool = null;

    try {
      // Create temporary connection to the specific database
      dbPool = new SQL({
        hostname: '127.0.0.1',
        port: this.pgPort,
        database: dbName,
        username: this.pgUser,
        password: this.pgPassword,
        max: 1,
        idleTimeout: 5,
        connectionTimeout: 5,
      });

      // Enable pgvector extension
      await dbPool.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
      this.logger.info({ dbName }, 'pgvector extension enabled');
    } catch (error) {
      // Log but don't fail database creation - pgvector might not be available
      this.logger.warn({ dbName, err: error.message }, 'Failed to enable pgvector extension (non-fatal)');
    } finally {
      // Always close the temporary connection
      if (dbPool) {
        await dbPool.close().catch(() => {});
      }
    }
  }

  /**
   * Handle socket open (Bun TCP handler)
   */
  handleSocketOpen(socket) {
    this.socketState.set(socket, {
      buffer: null,
      pgSocket: null,
      dbName: null,
      handshakeComplete: false,
      pendingToPg: null,
      pendingToClient: null
    });
    this.connections.add(socket);
    this.connectionStats.totalConnected++;
  }

  /**
   * Handle socket data (Bun TCP handler)
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

    this.processStartupMessage(socket, state);
  }

  /**
   * Process PostgreSQL startup message and establish proxy connection
   */
  async processStartupMessage(socket, state) {
    const buffer = state.buffer;
    if (!buffer || buffer.length < 8) return;

    const messageLength = buffer.readUInt32BE(0);
    if (buffer.length < messageLength) return;

    const code = buffer.readUInt32BE(4);

    // Handle SSL/GSSAPI/Cancel requests
    if (code === SSL_REQUEST_CODE || code === GSSAPI_REQUEST_CODE) {
      socket.write(Buffer.from('N'));
      state.buffer = buffer.length > messageLength ? buffer.subarray(messageLength) : null;
      return;
    }

    if (code === CANCEL_REQUEST_CODE) {
      socket.end();
      return;
    }

    if (code !== PROTOCOL_VERSION_3) {
      this.logger.warn({ code }, 'Unsupported protocol version');
      socket.end();
      return;
    }

    const startupMessage = buffer.subarray(0, messageLength);
    const dbName = extractDatabaseName(startupMessage);
    state.dbName = dbName;

    try {
      await this.createDatabase(dbName);

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

      if (this.pgSocketPath) {
        state.pgSocket = await Bun.connect({ unix: this.pgSocketPath, socket: pgHandler });
      } else {
        state.pgSocket = await Bun.connect({ hostname: '127.0.0.1', port: this.pgPort, socket: pgHandler });
      }
    } catch (error) {
      this.logger.error({ dbName, err: error }, 'Connection error');
      socket.end();
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
    this.connectionStats.totalDisconnected++;
  }

  /**
   * Get router stats for IPC reporting
   */
  getStats() {
    return {
      connections: this.connections.size,
      totalConnected: this.connectionStats.totalConnected,
      totalDisconnected: this.connectionStats.totalDisconnected,
      pid: process.pid
    };
  }

  /**
   * Handle socket error (Bun TCP handler)
   */
  handleSocketError(socket, error) {
    const state = this.socketState.get(socket);
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

  async stop() {
    for (const socket of this.connections) {
      socket.end();
    }
    this.connections.clear();

    if (this.sql) {
      try {
        await this.sql.close();
      } catch {
        // Expected: connection may already be terminated during cleanup
      }
    }

    // Close TCP server (Bun.listen returns a server with stop() method)
    if (this.server) {
      this.server.stop();
    }
  }
}


/**
 * Start pgserve in cluster mode
 */
export async function startClusterServer(options = {}) {
  const numWorkers = options.workers || os.cpus().length;
  const port = options.port || 8432;
  const host = options.host || '127.0.0.1';
  const pgPort = options.pgPort || (port + 1000);

  if (cluster.isPrimary) {
    // Port binding happens in workers via Bun.listen with reusePort
    // If port is in use, first worker will fail with EADDRINUSE
    console.log(`[pgserve] Cluster mode: ${numWorkers} workers`);

    // PRIMARY: Start our embedded PostgreSQL (single instance)
    const logger = createLogger({ level: options.logLevel || 'info' });
    const pgManager = new PostgresManager({
      dataDir: options.baseDir,
      port: pgPort,
      logger: logger.child({ component: 'postgres' }),
      useRam: options.useRam,  // Use /dev/shm for true RAM storage (Linux only)
      enablePgvector: options.enablePgvector  // Auto-enable pgvector extension on new databases
    });

    await pgManager.start();
    const pgSocketPath = pgManager.getSocketPath();

    console.log(`[pgserve] Embedded PostgreSQL started`);
    console.log(`[pgserve] Socket: ${pgSocketPath || `TCP port ${pgPort}`}`);

    const workers = new Map();
    const workerStats = new Map(); // Track stats from each worker

    // Fork workers with PostgreSQL connection info
    for (let i = 0; i < numWorkers; i++) {
      const worker = cluster.fork({
        PGSERVE_WORKER: 'true',
        PGSERVE_PORT: String(port),
        PGSERVE_HOST: host,
        PGSERVE_PG_SOCKET: pgSocketPath || '',
        PGSERVE_PG_PORT: String(pgPort),
        PGSERVE_PG_USER: 'postgres',
        PGSERVE_PG_PASSWORD: 'postgres',
        PGSERVE_LOG_LEVEL: options.logLevel || 'info',
        PGSERVE_AUTO_PROVISION: options.autoProvision !== false ? 'true' : 'false',
        PGSERVE_MAX_CONNECTIONS: String(options.maxConnections || 1000),
        PGSERVE_ENABLE_PGVECTOR: options.enablePgvector ? 'true' : 'false'
      });
      workers.set(worker.id, worker);
    }

    // Track shutdown state to prevent worker restart during shutdown
    let shuttingDown = false;

    // Restart dead workers (unless shutting down)
    cluster.on('exit', (worker, code, signal) => {
      workers.delete(worker.id);

      if (shuttingDown) {
        return; // Don't restart during shutdown
      }

      console.log(`[pgserve] Worker ${worker.id} died (${signal || code}), restarting...`);
      const newWorker = cluster.fork({
        PGSERVE_WORKER: 'true',
        PGSERVE_PORT: String(port),
        PGSERVE_HOST: host,
        PGSERVE_PG_SOCKET: pgSocketPath || '',
        PGSERVE_PG_PORT: String(pgPort),
        PGSERVE_PG_USER: 'postgres',
        PGSERVE_PG_PASSWORD: 'postgres',
        PGSERVE_LOG_LEVEL: options.logLevel || 'info',
        PGSERVE_AUTO_PROVISION: options.autoProvision !== false ? 'true' : 'false',
        PGSERVE_MAX_CONNECTIONS: String(options.maxConnections || 1000),
        PGSERVE_ENABLE_PGVECTOR: options.enablePgvector ? 'true' : 'false'
      });
      workers.set(newWorker.id, newWorker);
    });

    // Wait for workers to be ready and handle IPC messages
    let readyCount = 0;
    await new Promise((resolve) => {
      cluster.on('message', (worker, message) => {
        if (message.type === 'ready') {
          readyCount++;
          if (readyCount === numWorkers) resolve();
        } else if (message.type === 'stats') {
          // Update worker stats from IPC
          workerStats.set(worker.id, {
            ...message.data,
            lastUpdate: Date.now()
          });
        }
      });
    });

    console.log(`[pgserve] All ${numWorkers} workers ready`);
    console.log(`[pgserve] Listening on ${host}:${port}`);

    return {
      workers,
      pgPort,
      pgSocketPath,
      stop: async () => {
        console.log('[pgserve] Stopping cluster...');
        shuttingDown = true; // Prevent worker restart during shutdown
        for (const worker of workers.values()) {
          worker.send({ type: 'shutdown' });
        }
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (workers.size === 0) {
              clearInterval(check);
              resolve();
            }
          }, 100);
        });
        await pgManager.stop();
        console.log('[pgserve] Cluster stopped');
      },
      getStats: () => {
        // Aggregate stats from all workers
        let totalConnections = 0;
        let totalConnected = 0;
        let totalDisconnected = 0;
        const activeWorkerStats = {};

        for (const [id, stats] of workerStats) {
          // Only include recent stats (within timeout window)
          if (Date.now() - stats.lastUpdate < WORKER_STATS_TIMEOUT_MS) {
            totalConnections += stats.connections || 0;
            totalConnected += stats.totalConnected || 0;
            totalDisconnected += stats.totalDisconnected || 0;
            activeWorkerStats[id] = stats;
          }
        }

        return {
          workers: workers.size,
          pids: Array.from(workers.values()).map(w => w.process.pid),
          connections: {
            active: totalConnections,
            totalConnected,
            totalDisconnected
          },
          workerStats: activeWorkerStats
        };
      },
      pgManager
    };
  } else {
    // WORKER: Only run TCP routing, connect to PRIMARY's PostgreSQL
    const router = new ClusterRouter({
      port: parseInt(process.env.PGSERVE_PORT) || 8432,
      host: process.env.PGSERVE_HOST || '127.0.0.1',
      pgSocketPath: process.env.PGSERVE_PG_SOCKET || null,
      pgPort: parseInt(process.env.PGSERVE_PG_PORT) || 6432,
      pgUser: process.env.PGSERVE_PG_USER || 'postgres',
      pgPassword: process.env.PGSERVE_PG_PASSWORD || 'postgres',
      logLevel: process.env.PGSERVE_LOG_LEVEL || 'info',
      autoProvision: process.env.PGSERVE_AUTO_PROVISION === 'true',
      maxConnections: parseInt(process.env.PGSERVE_MAX_CONNECTIONS) || 1000,
      enablePgvector: process.env.PGSERVE_ENABLE_PGVECTOR === 'true'
    });

    await router.start();

    // Tell PRIMARY we're ready
    process.send({ type: 'ready' });

    // Periodically send stats to PRIMARY
    const statsInterval = setInterval(() => {
      try {
        process.send({ type: 'stats', data: router.getStats() });
      } catch {
        // Expected: IPC channel may be closed during shutdown
      }
    }, WORKER_STATS_REPORT_INTERVAL_MS);

    // Handle shutdown
    process.on('message', async (message) => {
      if (message.type === 'shutdown') {
        clearInterval(statsInterval);
        await router.stop();
        process.exit(0);
      }
    });

    return router;
  }
}
