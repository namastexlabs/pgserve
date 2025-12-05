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
    this.baseDir = options.baseDir || null; // null = memory mode
    this.memoryMode = !options.baseDir;
    this.maxConnections = options.maxConnections || 1000;
    this.autoProvision = options.autoProvision !== false;

    // Internal PostgreSQL port (different from router port)
    this.pgPort = options.pgPort || (this.port + 1000);

    // Pino logger (ultra-fast structured logging)
    const logLevel = options.logLevel || 'info';
    this.logger = options.logger || pino({
      level: logLevel,
      transport: logLevel === 'debug' ? {
        target: 'pino-pretty',
        options: { colorize: true }
      } : undefined
    });

    // PostgreSQL manager
    this.pgManager = new PostgresManager({
      dataDir: this.baseDir,
      port: this.pgPort,
      logger: this.logger.child({ component: 'postgres' })
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
    // Start PostgreSQL first
    await this.pgManager.start();

    return new Promise((resolve, reject) => {
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
        this.logger.info({
          host: this.host,
          port: this.port,
          pgPort: this.pgPort,
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
   */
  async handleConnection(socket) {
    const connId = `${socket.remoteAddress}:${socket.remotePort}`;
    const startTime = Date.now();

    // Optimize socket BEFORE any I/O
    this.optimizeSocket(socket);

    // Track connection
    this.connections.add(socket);

    let dbName = null;
    let pgSocket = null;

    try {
      // Extract database name from PostgreSQL handshake
      this.logger.debug({ connId }, 'Reading startup message');
      const { dbName: extractedDbName, buffered } = await extractDatabaseNameFromSocket(socket);
      dbName = extractedDbName;

      this.logger.info({ dbName, connId }, 'Connection request');

      // Auto-provision database if needed
      if (this.autoProvision) {
        await this.pgManager.createDatabase(dbName);
      }

      const routingTime = Date.now() - startTime;
      this.logger.info({
        dbName,
        connId,
        routingTimeMs: routingTime
      }, 'Routing to PostgreSQL');

      // Connect to real PostgreSQL
      pgSocket = net.connect({
        host: '127.0.0.1',
        port: this.pgPort
      });

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

      this.logger.debug({ dbName, connId }, 'Connection established');

      // Handle cleanup
      const cleanup = () => {
        this.logger.debug({ dbName, connId }, 'Connection closed');
        this.connections.delete(socket);

        if (pgSocket && !pgSocket.destroyed) {
          pgSocket.destroy();
        }
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      socket.once('close', cleanup);
      socket.once('error', (error) => {
        this.logger.warn({ dbName, connId, err: error }, 'Client socket error');
        cleanup();
      });

      pgSocket.once('close', () => {
        this.logger.debug({ dbName, connId }, 'PostgreSQL connection closed');
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      });

      pgSocket.once('error', (error) => {
        this.logger.warn({ dbName, connId, err: error }, 'PostgreSQL socket error');
        cleanup();
      });

      this.emit('connection', { dbName, socket, connId });
    } catch (error) {
      this.logger.error({ dbName, connId, err: error }, 'Connection error');

      // Cleanup
      if (pgSocket && !pgSocket.destroyed) {
        pgSocket.destroy();
      }

      socket.destroy();
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
      socket.end();
    }
    this.connections.clear();

    // Close TCP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
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
