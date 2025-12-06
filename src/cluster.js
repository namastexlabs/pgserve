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
import net from 'net';
import pg from 'pg';
import { createLogger } from './logger.js';
import { PostgresManager } from './postgres.js';
import { extractDatabaseNameFromSocket } from './protocol.js';
import { EventEmitter } from 'events';

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
    this.adminClient = null;
    this.server = null;
    this.connections = new Set();
    this.setMaxListeners(this.maxConnections + 10);
  }

  optimizeSocket(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.setTimeout(0);
  }

  async start() {
    // Admin connection for auto-provisioning databases
    if (this.autoProvision) {
      let connectionConfig;
      if (this.pgSocketPath) {
        // pg library expects socket DIRECTORY as host, it appends .s.PGSQL.<port>
        // Socket path format: /tmp/pgserve-sock-xxx/.s.PGSQL.<port>
        // Extract directory by removing the socket file suffix
        const socketDir = this.pgSocketPath.replace(/\/\.s\.PGSQL\.\d+$/, '');
        connectionConfig = {
          host: socketDir,
          port: this.pgPort,
          database: 'postgres',
          user: this.pgUser,
          password: this.pgPassword
        };
      } else {
        connectionConfig = {
          host: '127.0.0.1',
          port: this.pgPort,
          database: 'postgres',
          user: this.pgUser,
          password: this.pgPassword
        };
      }

      this.adminClient = new pg.Client(connectionConfig);
      // Suppress errors during shutdown (PostgreSQL terminating connections)
      this.adminClient.on('error', () => {});
      await this.adminClient.connect();
    }

    return new Promise((resolve, _reject) => {
      this.server = net.createServer({
        allowHalfOpen: false,
        pauseOnConnect: true
      }, (socket) => this.handleConnection(socket));

      this.server.maxConnections = this.maxConnections;

      this.server.on('error', (error) => {
        this.logger.error({ err: error }, 'Router error');
        this.emit('error', error);
      });

      this.server.listen(this.port, this.host, () => {
        this.emit('listening');
        resolve();
      });
    });
  }

  async createDatabase(dbName) {
    if (!this.autoProvision || !this.adminClient) return;

    try {
      const result = await this.adminClient.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );

      if (result.rows.length === 0) {
        await this.adminClient.query(`CREATE DATABASE "${dbName}"`);
      }
    } catch (error) {
      // Ignore "already exists" (race condition between workers)
      if (!error.message.includes('already exists')) {
        this.logger.error({ database: dbName, err: error }, 'Failed to create database');
      }
    }
  }

  async handleConnection(socket) {
    this.connections.add(socket);
    this.optimizeSocket(socket);

    let dbName = null;
    let pgSocket = null;

    try {
      const { dbName: extractedDbName, buffered } = await extractDatabaseNameFromSocket(socket);
      dbName = extractedDbName;

      await this.createDatabase(dbName);

      // Connect to PRIMARY's PostgreSQL
      if (this.pgSocketPath) {
        pgSocket = net.connect({ path: this.pgSocketPath });
      } else {
        pgSocket = net.connect({ host: '127.0.0.1', port: this.pgPort });
      }

      await new Promise((resolve, reject) => {
        pgSocket.once('connect', resolve);
        pgSocket.once('error', reject);
      });

      this.optimizeSocket(pgSocket);
      pgSocket.write(buffered);
      socket.resume();

      // Bidirectional pipe
      socket.pipe(pgSocket);
      pgSocket.pipe(socket);

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

    } catch (error) {
      this.logger.error({ dbName, err: error }, 'Connection error');
      if (pgSocket && !pgSocket.destroyed) pgSocket.destroy();
      socket.destroy();
      this.connections.delete(socket);
    }
  }

  async stop() {
    for (const socket of this.connections) {
      socket.end();
    }
    this.connections.clear();

    if (this.adminClient) {
      try {
        await this.adminClient.end();
      } catch {
        // Ignore - connection may already be terminated
      }
    }

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
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
    console.log(`[pgserve] Cluster mode: ${numWorkers} workers`);

    // PRIMARY: Start our embedded PostgreSQL (single instance)
    const logger = createLogger({ level: options.logLevel || 'info' });
    const pgManager = new PostgresManager({
      dataDir: options.baseDir,
      port: pgPort,
      logger: logger.child({ component: 'postgres' })
    });

    await pgManager.start();
    const pgSocketPath = pgManager.getSocketPath();

    console.log(`[pgserve] Embedded PostgreSQL started`);
    console.log(`[pgserve] Socket: ${pgSocketPath || `TCP port ${pgPort}`}`);

    const workers = new Map();

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

    // Wait for workers to be ready
    let readyCount = 0;
    await new Promise((resolve) => {
      cluster.on('message', (worker, message) => {
        if (message.type === 'ready') {
          readyCount++;
          if (readyCount === numWorkers) resolve();
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
      getStats: () => ({
        workers: workers.size,
        pids: Array.from(workers.values()).map(w => w.process.pid)
      })
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

    // Handle shutdown
    process.on('message', async (message) => {
      if (message.type === 'shutdown') {
        await router.stop();
        process.exit(0);
      }
    });

    return router;
  }
}
