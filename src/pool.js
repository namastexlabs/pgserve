/**
 * PGlite Instance Pool (Performance Optimized)
 *
 * Manages multiple PGlite instances (one per database)
 * Handles lazy initialization, connection locking, and cleanup
 *
 * Performance Optimizations:
 * - Fast Map-based lookups (O(1) access)
 * - Minimal memory overhead per instance
 * - Pino structured logging
 * - Proper event listener cleanup
 */

import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

/**
 * Wrapper for PGlite instance with connection management
 */
class ManagedInstance extends EventEmitter {
  constructor(dbName, dataDir, logger) {
    super();
    this.dbName = dbName;
    this.dataDir = dataDir;
    this.logger = logger; // Pino logger
    this.db = null;
    this.locked = false;
    this.activeSocket = null;
    this.queue = [];
    this.createdAt = Date.now();
    this.lastAccess = Date.now();

    // Performance: Limit max listeners
    this.setMaxListeners(10);
  }

  /**
   * Initialize PGlite instance (lazy)
   */
  async initialize() {
    if (this.db) {
      return this.db;
    }

    const initStart = Date.now();

    // Ensure directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.logger.debug({ dbName: this.dbName, dataDir: this.dataDir }, 'Initializing PGlite instance');

    this.db = new PGlite(this.dataDir);
    await this.db.waitReady;

    const initTime = Date.now() - initStart;
    this.logger.info({
      dbName: this.dbName,
      dataDir: this.dataDir,
      initTimeMs: initTime
    }, 'PGlite instance initialized');

    this.emit('initialized', this.dbName);
    return this.db;
  }

  /**
   * Lock instance to a socket
   */
  lock(socket) {
    if (this.locked) {
      throw new Error(`Instance ${this.dbName} is already locked`);
    }

    this.locked = true;
    this.activeSocket = socket;
    this.lastAccess = Date.now();

    // Only attach event listeners if socket is provided
    if (socket) {
      socket.on('close', () => this.unlock());
      socket.on('error', () => this.unlock());
    }

    this.emit('locked', this.dbName, socket);
  }

  /**
   * Unlock instance (connection closed)
   */
  unlock() {
    this.locked = false;
    this.activeSocket = null;
    this.lastAccess = Date.now();

    this.emit('unlocked', this.dbName);

    // Resolve one waiting promise (it will lock, then when it unlocks, the next will be resolved)
    if (this.queue.length > 0) {
      const { resolve } = this.queue.shift();
      // Don't lock here - let the acquire() caller handle locking with their socket
      resolve(this);
    }
  }

  /**
   * Wait for instance to be free
   */
  async waitForFree(timeout = 30000) {
    if (!this.locked) {
      return this;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ socket: null, resolve, reject });

      const timer = setTimeout(() => {
        const index = this.queue.findIndex((item) => item.resolve === resolve);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for database ${this.dbName}`));
      }, timeout);

      // Clear timeout on resolve
      this.once('unlocked', () => clearTimeout(timer));
    });
  }

  /**
   * Close PGlite instance
   */
  async close() {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        // Ignore ExitStatus errors (normal WASM cleanup)
        if (error.name !== 'ExitStatus') {
          console.error(`Error closing instance ${this.dbName}:`, error.message);
        }
      }
    }

    this.db = null;
    this.emit('closed', this.dbName);
  }

  /**
   * Get instance stats
   */
  getStats() {
    return {
      dbName: this.dbName,
      locked: this.locked,
      queueLength: this.queue.length,
      uptime: Date.now() - this.createdAt,
      lastAccess: Date.now() - this.lastAccess
    };
  }
}

/**
 * PGlite Instance Pool
 */
export class InstancePool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseDir = options.baseDir || './data';
    this.maxInstances = options.maxInstances || 100;
    this.autoProvision = options.autoProvision !== false; // Default true
    this.instances = new Map(); // dbName -> ManagedInstance (O(1) lookups)
    this.logger = options.logger; // Pino logger

    // Performance: Set max listeners based on max instances
    this.setMaxListeners(this.maxInstances + 10);
  }

  /**
   * Get or create PGlite instance for database (Performance Optimized)
   */
  async getOrCreate(dbName) {
    // Fast path: Check cache first (O(1) lookup)
    let instance = this.instances.get(dbName);

    if (!instance) {
      // Check max instances limit
      if (this.instances.size >= this.maxInstances) {
        this.logger.error({
          dbName,
          currentInstances: this.instances.size,
          maxInstances: this.maxInstances
        }, 'Maximum instances limit reached');

        throw new Error(
          `Maximum instances limit reached (${this.maxInstances}). ` +
            `Cannot create database: ${dbName}`
        );
      }

      if (!this.autoProvision) {
        this.logger.warn({ dbName }, 'Database does not exist (auto-provision disabled)');
        throw new Error(`Database ${dbName} does not exist (auto-provision disabled)`);
      }

      // Create new instance
      const dataDir = path.join(this.baseDir, dbName);
      instance = new ManagedInstance(
        dbName,
        dataDir,
        this.logger.child({ dbName }) // Child logger with context
      );

      // Forward events (use once() where appropriate for performance)
      instance.on('initialized', (name) => this.emit('instance-created', name));
      instance.on('locked', (name) => this.emit('instance-locked', name));
      instance.on('unlocked', (name) => this.emit('instance-unlocked', name));
      instance.on('closed', (name) => this.emit('instance-closed', name));

      // Add to cache BEFORE initialization (prevents race conditions)
      this.instances.set(dbName, instance);
    }

    // Lazy initialize (async, may already be initialized)
    await instance.initialize();

    return instance;
  }

  /**
   * Acquire instance (lock to socket)
   */
  async acquire(dbName, socket, timeout = 30000) {
    const instance = await this.getOrCreate(dbName);

    // If locked, wait for it to be free
    if (instance.locked) {
      console.log(`⏳ Database ${dbName} is busy, queuing connection...`);
      await instance.waitForFree(timeout);
    }

    // Lock to this socket
    instance.lock(socket);

    return instance;
  }

  /**
   * Get instance (without locking)
   */
  get(dbName) {
    return this.instances.get(dbName);
  }

  /**
   * List all instances
   */
  list() {
    return Array.from(this.instances.values()).map((instance) => instance.getStats());
  }

  /**
   * Close specific instance
   */
  async closeInstance(dbName) {
    const instance = this.instances.get(dbName);
    if (instance) {
      await instance.close();
      this.instances.delete(dbName);
    }
  }

  /**
   * Close all instances
   */
  async closeAll() {
    const promises = Array.from(this.instances.values()).map((instance) => instance.close());
    await Promise.all(promises);
    this.instances.clear();
  }

  /**
   * Get pool stats
   */
  getStats() {
    return {
      totalInstances: this.instances.size,
      maxInstances: this.maxInstances,
      instances: this.list()
    };
  }
}
