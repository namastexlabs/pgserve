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
          if (state?.pgSocket) {
            state.pgSocket.resume?.();
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
      }
    } catch (error) {
      // Ignore "already exists" (race condition between workers)
      if (!error.message?.includes('already exists')) {
        this.logger.error({ database: dbName, err: error }, 'Failed to create database');
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
      handshakeComplete: false
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
      state.pgSocket.write(data);
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

      // Connect to PRIMARY's PostgreSQL using Bun.connect()
      if (this.pgSocketPath) {
        state.pgSocket = await Bun.connect({
          unix: this.pgSocketPath,
          socket: {
            data(_pgSocket, pgData) {
              socket.write(pgData);
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
            drain(_pgSocket) {}
          }
        });
      } else {
        state.pgSocket = await Bun.connect({
          hostname: '127.0.0.1',
          port: this.pgPort,
          socket: {
            data(_pgSocket, pgData) {
              socket.write(pgData);
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
            drain(_pgSocket) {}
          }
        });
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
    if (state?.pgSocket) {
      state.pgSocket.end();
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
    if (state?.pgSocket) {
      state.pgSocket.end();
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
        // Ignore - connection may already be terminated
      }
    }

    // Close TCP server (Bun.listen returns a server with stop() method)
    if (this.server) {
      this.server.stop();
    }
  }
}

/**
 * Check if a port is already in use
 */
async function isPortInUse(port, host = '127.0.0.1') {
  try {
    const server = Bun.listen({
      hostname: host,
      port: port,
      reusePort: false, // Explicitly disable to detect conflicts
      socket: {
        data() {},
        open() {},
        close() {},
        error() {}
      }
    });
    server.stop();
    return false; // Port is free
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      return true; // Port in use
    }
    throw err; // Re-throw unexpected errors
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
    // Check if port is already in use before starting
    const portInUse = await isPortInUse(port, host);
    if (portInUse) {
      throw new Error(`Port ${port} is already in use. Kill existing process or use a different port.`);
    }
    console.log(`[pgserve] Cluster mode: ${numWorkers} workers`);

    // PRIMARY: Start our embedded PostgreSQL (single instance)
    const logger = createLogger({ level: options.logLevel || 'info' });
    const pgManager = new PostgresManager({
      dataDir: options.baseDir,
      port: pgPort,
      logger: logger.child({ component: 'postgres' }),
      useRam: options.useRam  // Use /dev/shm for true RAM storage (Linux only)
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
        PGSERVE_AUTO_PROVISION: options.autoProvision !== false ? 'true' : 'false'
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
        PGSERVE_AUTO_PROVISION: options.autoProvision !== false ? 'true' : 'false'
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
          // Only include recent stats (last 10 seconds)
          if (Date.now() - stats.lastUpdate < 10000) {
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
      autoProvision: process.env.PGSERVE_AUTO_PROVISION === 'true'
    });

    await router.start();

    // Tell PRIMARY we're ready
    process.send({ type: 'ready' });

    // Periodically send stats to PRIMARY (every 4 seconds)
    const statsInterval = setInterval(() => {
      try {
        process.send({ type: 'stats', data: router.getStats() });
      } catch {
        // IPC may be closed during shutdown
      }
    }, 4000);

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
