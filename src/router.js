/**
 * Multi-Tenant Router (Performance Optimized)
 *
 * Single TCP server that routes connections to different PGlite instances
 * based on database name from PostgreSQL connection string
 *
 * Performance Optimizations:
 * - Pino logger (5x faster than console.log)
 * - TCP socket optimizations (nodelay, keepalive)
 * - Minimal event emitter overhead
 * - Optimized connection tracking
 */

import net from 'net';
import { PGLiteSocketHandler } from '@electric-sql/pglite-socket';
import { InstancePool } from './pool.js';
import { extractDatabaseNameFromSocket } from './protocol.js';
import { EventEmitter } from 'events';
import pino from 'pino';

/**
 * Multi-Tenant Router Server
 */
export class MultiTenantRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 5432;
    this.host = options.host || '127.0.0.1';
    this.baseDir = options.baseDir || './data';
    this.memoryMode = options.memoryMode || false;
    this.maxInstances = options.maxInstances || 100;
    this.autoProvision = options.autoProvision !== false;
    this.inspect = options.inspect || false;

    // Pino logger (ultra-fast structured logging)
    const logLevel = options.logLevel || 'info';
    this.logger = options.logger || pino({
      level: logLevel,
      transport: logLevel === 'debug' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });

    // Instance pool
    this.pool = new InstancePool({
      baseDir: this.baseDir,
      memoryMode: this.memoryMode,
      maxInstances: this.maxInstances,
      autoProvision: this.autoProvision,
      logger: this.logger.child({ component: 'pool' })
    });

    // TCP server
    this.server = null;
    this.connections = new Set();

    // Performance: Reduce event listener overhead
    this.setMaxListeners(this.maxInstances + 10);

    // Forward pool events (optimized logging)
    this.pool.on('instance-created', (dbName) => {
      this.logger.info({ dbName }, 'Database created');
      this.emit('database-created', dbName);
    });

    this.pool.on('instance-locked', (dbName) => {
      this.logger.debug({ dbName }, 'Database locked');
    });

    this.pool.on('instance-unlocked', (dbName) => {
      this.logger.debug({ dbName }, 'Database unlocked');
    });
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

    // Increase socket buffer sizes for better throughput
    // Note: These are hints to OS, actual values may differ
    try {
      socket.setRecvBufferSize && socket.setRecvBufferSize(128 * 1024); // 128KB
      socket.setSendBufferSize && socket.setSendBufferSize(128 * 1024); // 128KB
    } catch (err) {
      // Ignore if not supported
      this.logger.debug({ err }, 'Could not set socket buffer sizes');
    }

    // Prevent socket timeout during long-running queries
    socket.setTimeout(0);
  }

  /**
   * Start multi-tenant router
   */
  async start() {
    return new Promise((resolve, reject) => {
      // Create TCP server with optimizations
      this.server = net.createServer({
        // Performance: Allow half-open sockets (faster cleanup)
        allowHalfOpen: false,
        // Performance: Pause on connect (manual resume after setup)
        pauseOnConnect: true
      }, async (socket) => {
        await this.handleConnection(socket);
      });

      // Set max connections (system limit)
      this.server.maxConnections = this.maxInstances * 2;

      // Error handling
      this.server.on('error', (error) => {
        this.logger.error({ err: error }, 'Server error');
        this.emit('error', error);
      });

      // Start listening
      this.server.listen(this.port, this.host, () => {
        this.logger.info({
          host: this.host,
          port: this.port,
          baseDir: this.memoryMode ? '(in-memory)' : this.baseDir,
          memoryMode: this.memoryMode,
          autoProvision: this.autoProvision,
          maxInstances: this.maxInstances
        }, 'Multi-tenant router started');

        this.emit('listening');
        resolve();
      });
    });
  }

  /**
   * Handle incoming connection (Performance Optimized)
   */
  async handleConnection(socket) {
    const connId = `${socket.remoteAddress}:${socket.remotePort}`;
    const startTime = Date.now();

    // Optimize socket BEFORE any I/O
    this.optimizeSocket(socket);

    // Track connection
    this.connections.add(socket);

    // Resume socket (was paused on connect)
    socket.resume();

    let dbName = null;
    let handler = null;

    try {
      // Extract database name from PostgreSQL handshake
      this.logger.debug({ connId }, 'Reading startup message');
      const { dbName: extractedDbName, buffered } = await extractDatabaseNameFromSocket(socket);
      dbName = extractedDbName;

      this.logger.info({ dbName, connId }, 'Connection request');

      // Get or create PGlite instance (with locking)
      const instance = await this.pool.acquire(dbName, socket);

      const routingTime = Date.now() - startTime;
      this.logger.info({
        dbName,
        connId,
        dataDir: instance.dataDir,
        routingTimeMs: routingTime
      }, 'Routed to database');

      // Push buffered data back to socket for handler to read
      socket.unshift(buffered);

      // Create handler for this connection
      handler = new PGLiteSocketHandler({
        db: instance.db,
        closeOnDetach: true,
        inspect: this.inspect
      });

      // Attach socket to handler
      await handler.attach(socket);

      this.logger.debug({ dbName, connId }, 'Socket attached');

      // Handle socket close (cleanup)
      const cleanup = () => {
        this.logger.debug({ dbName, connId }, 'Connection closed');
        if (handler) {
          handler.detach();
        }
        this.connections.delete(socket);
        // Note: Don't call socket.removeAllListeners() here as it removes
        // the pool's unlock handlers before they can fire, causing stuck locks
      };

      socket.once('close', cleanup);
      socket.once('error', (error) => {
        this.logger.warn({ dbName, connId, err: error }, 'Socket error');
        cleanup();
      });

      this.emit('connection', { dbName, socket, connId });
    } catch (error) {
      this.logger.error({ dbName, connId, err: error }, 'Connection error');

      // Cleanup
      if (handler) {
        try {
          handler.detach();
        } catch (detachErr) {
          this.logger.debug({ err: detachErr }, 'Error detaching handler');
        }
      }

      socket.destroy(); // Force close on error
      this.connections.delete(socket);
      this.emit('connection-error', { error, dbName, connId });
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
      socket.end(); // Graceful close (vs destroy())
    }
    this.connections.clear();

    // Close TCP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }

    // Close all PGlite instances
    await this.pool.closeAll();

    this.logger.info({
      activeConnections: activeConns,
      closedInstances: this.pool.instances.size
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
      activeConnections: this.connections.size,
      pool: this.pool.getStats()
    };
  }

  /**
   * List all databases
   */
  listDatabases() {
    return this.pool.list();
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
