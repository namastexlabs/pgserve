/**
 * Multi-Tenant Router
 *
 * Single TCP server that routes connections to different PGlite instances
 * based on database name from PostgreSQL connection string
 */

import net from 'net';
import { PGLiteSocketHandler } from '@electric-sql/pglite-socket';
import { InstancePool } from './pool.js';
import { extractDatabaseNameFromSocket } from './protocol.js';
import { EventEmitter } from 'events';

/**
 * Multi-Tenant Router Server
 */
export class MultiTenantRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 5432;
    this.host = options.host || '127.0.0.1';
    this.baseDir = options.baseDir || './data';
    this.maxInstances = options.maxInstances || 100;
    this.autoProvision = options.autoProvision !== false;
    this.logLevel = options.logLevel || 'info';
    this.inspect = options.inspect || false;

    // Instance pool
    this.pool = new InstancePool({
      baseDir: this.baseDir,
      maxInstances: this.maxInstances,
      autoProvision: this.autoProvision
    });

    // TCP server
    this.server = null;
    this.connections = new Set();

    // Forward pool events
    this.pool.on('instance-created', (dbName) => {
      this.log('info', `📦 Database created: ${dbName}`);
      this.emit('database-created', dbName);
    });

    this.pool.on('instance-locked', (dbName) => {
      this.log('debug', `🔒 Database locked: ${dbName}`);
    });

    this.pool.on('instance-unlocked', (dbName) => {
      this.log('debug', `🔓 Database unlocked: ${dbName}`);
    });
  }

  /**
   * Log message based on log level
   */
  log(level, message) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    if (levels[level] <= levels[this.logLevel]) {
      console.log(message);
    }
  }

  /**
   * Start multi-tenant router
   */
  async start() {
    return new Promise((resolve, reject) => {
      // Create TCP server
      this.server = net.createServer(async (socket) => {
        await this.handleConnection(socket);
      });

      // Error handling
      this.server.on('error', (error) => {
        this.log('error', `❌ Server error: ${error.message}`);
        this.emit('error', error);
      });

      // Start listening
      this.server.listen(this.port, this.host, () => {
        this.log('info', `✅ Multi-tenant router running on ${this.host}:${this.port}`);
        this.log('info', `📁 Base data directory: ${this.baseDir}`);
        this.log('info', `🎯 Auto-provision: ${this.autoProvision ? 'enabled' : 'disabled'}`);
        this.log('info', `📊 Max instances: ${this.maxInstances}`);
        this.emit('listening');
        resolve();
      });
    });
  }

  /**
   * Handle incoming connection
   */
  async handleConnection(socket) {
    this.connections.add(socket);

    try {
      // Extract database name from PostgreSQL handshake
      this.log('debug', '🔍 Reading PostgreSQL startup message...');
      const { dbName, buffered } = await extractDatabaseNameFromSocket(socket);

      this.log('info', `📥 Connection request for database: ${dbName}`);

      // Get or create PGlite instance (with locking)
      const instance = await this.pool.acquire(dbName, socket);

      this.log('info', `✅ Routing to database: ${dbName} (${instance.dataDir})`);

      // Push buffered data back to socket for handler to read
      socket.unshift(buffered);

      // Create handler for this connection
      const handler = new PGLiteSocketHandler({
        db: instance.db,
        closeOnDetach: true,
        inspect: this.inspect
      });

      // Attach socket to handler
      await handler.attach(socket);

      this.log('debug', `🔗 Socket attached to ${dbName}`);

      // Handle socket close
      socket.on('close', () => {
        this.log('debug', `🔌 Connection closed for ${dbName}`);
        handler.detach();
        this.connections.delete(socket);
      });

      socket.on('error', (error) => {
        this.log('warn', `⚠️  Socket error for ${dbName}: ${error.message}`);
        handler.detach();
        this.connections.delete(socket);
      });

      this.emit('connection', { dbName, socket });
    } catch (error) {
      this.log('error', `❌ Connection error: ${error.message}`);
      socket.end();
      this.connections.delete(socket);
      this.emit('connection-error', error);
    }
  }

  /**
   * Stop router
   */
  async stop() {
    this.log('info', '🛑 Stopping multi-tenant router...');

    // Close all connections
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

    // Close all PGlite instances
    await this.pool.closeAll();

    this.log('info', '✅ Router stopped');
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
