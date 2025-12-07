/**
 * SyncManager - Async replication from pgserve to real PostgreSQL
 *
 * Uses PostgreSQL's native logical replication for ZERO hot-path impact.
 * All replication is handled by PostgreSQL's WAL writer process, not Node.js.
 *
 * 100% Bun-native: Uses Bun.sql for all database operations.
 */

import { SQL } from 'bun';
import { createLogger } from './logger.js';

/**
 * Match database name against patterns (supports wildcards)
 * @param {string} dbName - Database name to check
 * @param {string[]} patterns - Array of patterns (supports * wildcard)
 * @returns {boolean}
 */
function matchesPattern(dbName, patterns) {
  if (!patterns || patterns.length === 0) return true; // No filter = sync all

  return patterns.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(dbName);
    }
    return dbName === pattern;
  });
}

/**
 * SyncManager - Handles async replication to target PostgreSQL
 */
export class SyncManager {
  constructor(options = {}) {
    this.targetUrl = options.targetUrl;           // Real PostgreSQL connection string
    this.databases = options.databases || [];      // Patterns: ["myapp", "tenant_*"]
    this.sourcePort = options.sourcePort;          // pgserve PostgreSQL port
    this.sourceSocketPath = options.sourceSocketPath; // pgserve socket path (optional)

    this.logger = createLogger({ level: options.logLevel || 'info', component: 'sync' });

    this.sourceSql = null;  // Bun.sql connection to pgserve's PostgreSQL
    this.targetSql = null;  // Bun.sql connection to real PostgreSQL
    this.syncedDatabases = new Set();
    this.initialized = false;
  }

  /**
   * Initialize the SyncManager after PostgreSQL is ready
   * @param {Object} _pgManager - PostgresManager instance (unused, reserved for future)
   */
  async initialize(_pgManager) {
    if (!this.targetUrl) {
      throw new Error('SyncManager requires targetUrl');
    }

    this.logger.info({ target: this.targetUrl.replace(/:[^:@]+@/, ':***@') }, 'Initializing sync manager');

    // Create Bun.sql connection to source (pgserve's embedded PostgreSQL)
    this.sourceSql = new SQL({
      hostname: this.sourceSocketPath
        ? this.sourceSocketPath.replace(/\/\.s\.PGSQL\.\d+$/, '')
        : '127.0.0.1',
      port: this.sourcePort,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      max: 3,  // Low pool size - replication is async, not latency-sensitive
      idleTimeout: 30,
    });

    // Create Bun.sql connection to target (real PostgreSQL)
    const targetUrl = new URL(this.targetUrl);
    this.targetSql = new SQL({
      hostname: targetUrl.hostname,
      port: parseInt(targetUrl.port) || 5432,
      database: targetUrl.pathname.slice(1) || 'postgres',
      username: targetUrl.username || 'postgres',
      password: targetUrl.password || 'postgres',
      max: 3,
      idleTimeout: 30,
    });

    // Test connections
    try {
      await this.sourceSql`SELECT 1`;
      this.logger.debug('Source connection ready');
    } catch (err) {
      this.logger.error({ err }, 'Failed to connect to source PostgreSQL');
      throw err;
    }

    try {
      await this.targetSql`SELECT 1`;
      this.logger.debug('Target connection ready');
    } catch (err) {
      this.logger.error({ err }, 'Failed to connect to target PostgreSQL');
      throw err;
    }

    this.initialized = true;
    this.logger.info('Sync manager initialized');
  }

  /**
   * Check if a database should be synced based on patterns
   * @param {string} dbName
   * @returns {boolean}
   */
  shouldSync(dbName) {
    // Skip system databases
    if (['postgres', 'template0', 'template1'].includes(dbName)) {
      return false;
    }
    return matchesPattern(dbName, this.databases);
  }

  /**
   * Setup replication for a specific database
   * Called when a new database is created in pgserve
   *
   * This is NON-BLOCKING - runs in background, doesn't affect hot path
   *
   * @param {string} dbName - Name of the database to sync
   */
  async setupDatabaseSync(dbName) {
    if (!this.initialized) {
      this.logger.warn({ dbName }, 'Sync manager not initialized, skipping sync setup');
      return;
    }

    if (!this.shouldSync(dbName)) {
      this.logger.debug({ dbName }, 'Database does not match sync patterns, skipping');
      return;
    }

    if (this.syncedDatabases.has(dbName)) {
      this.logger.debug({ dbName }, 'Database already synced');
      return;
    }

    this.logger.info({ dbName }, 'Setting up database sync');

    try {
      // Step 1: Create database on target if it doesn't exist
      await this.ensureTargetDatabase(dbName);

      // Step 2: Setup publication on source (pgserve)
      await this.setupPublication(dbName);

      // Step 3: Setup subscription on target
      await this.setupSubscription(dbName);

      this.syncedDatabases.add(dbName);
      this.logger.info({ dbName }, 'Database sync established');

    } catch (err) {
      // Non-fatal - sync failure doesn't affect main server operation
      this.logger.error({ dbName, err }, 'Failed to setup database sync');
    }
  }

  /**
   * Ensure the database exists on target PostgreSQL
   * @param {string} dbName
   */
  async ensureTargetDatabase(dbName) {
    const result = await this.targetSql`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;

    if (result.length === 0) {
      // CREATE DATABASE cannot run in transaction - use unsafe for DDL
      const safeName = dbName.replace(/"/g, '""');
      await this.targetSql.unsafe(`CREATE DATABASE "${safeName}"`);
      this.logger.debug({ dbName }, 'Created database on target');
    }
  }

  /**
   * Setup publication on source (pgserve's PostgreSQL)
   * @param {string} dbName
   */
  async setupPublication(dbName) {
    // Connect to the specific database on source
    const sourceDbSql = new SQL({
      hostname: this.sourceSocketPath
        ? this.sourceSocketPath.replace(/\/\.s\.PGSQL\.\d+$/, '')
        : '127.0.0.1',
      port: this.sourcePort,
      database: dbName,
      username: 'postgres',
      password: 'postgres',
      max: 1,
    });

    try {
      const pubName = `pgserve_pub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;

      // Check if publication exists
      const result = await sourceDbSql`
        SELECT 1 FROM pg_publication WHERE pubname = ${pubName}
      `;

      if (result.length === 0) {
        // Create publication for all tables
        await sourceDbSql.unsafe(`CREATE PUBLICATION "${pubName}" FOR ALL TABLES`);
        this.logger.debug({ dbName, pubName }, 'Created publication on source');
      }
    } finally {
      await sourceDbSql.close();
    }
  }

  /**
   * Setup subscription on target PostgreSQL
   * @param {string} dbName
   */
  async setupSubscription(dbName) {
    // Connect to the specific database on target
    const targetUrl = new URL(this.targetUrl);

    const targetDbSql = new SQL({
      hostname: targetUrl.hostname,
      port: parseInt(targetUrl.port) || 5432,
      database: dbName,
      username: targetUrl.username || 'postgres',
      password: targetUrl.password || 'postgres',
      max: 1,
    });

    try {
      const subName = `pgserve_sub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;
      const pubName = `pgserve_pub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;

      // Check if subscription exists
      const result = await targetDbSql`
        SELECT 1 FROM pg_subscription WHERE subname = ${subName}
      `;

      if (result.length === 0) {
        // Build connection string to source - ALWAYS use TCP for cross-container compatibility
        // (Unix sockets won't work when target is in Docker or remote)
        const sourceConnStr = `host=127.0.0.1 port=${this.sourcePort} dbname=${dbName} user=postgres password=postgres`;

        // Create subscription
        await targetDbSql.unsafe(`
          CREATE SUBSCRIPTION "${subName}"
          CONNECTION '${sourceConnStr}'
          PUBLICATION "${pubName}"
          WITH (copy_data = true, create_slot = true)
        `);
        this.logger.debug({ dbName, subName }, 'Created subscription on target');
      }
    } finally {
      await targetDbSql.close();
    }
  }

  /**
   * Get replication status for all synced databases
   * @returns {Promise<Object>}
   */
  async getReplicationStatus() {
    if (!this.initialized) {
      return { initialized: false, databases: [] };
    }

    const status = {
      initialized: true,
      targetUrl: this.targetUrl.replace(/:[^:@]+@/, ':***@'),
      databases: [],
      replicationSlots: []
    };

    try {
      // Query replication slots from source
      const slotsResult = await this.sourceSql`
        SELECT slot_name, active, restart_lsn, confirmed_flush_lsn
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
      `;

      status.replicationSlots = slotsResult.map(row => ({
        name: row.slot_name,
        active: row.active,
        restartLsn: row.restart_lsn,
        confirmedFlushLsn: row.confirmed_flush_lsn
      }));

      // Query replication lag
      const lagResult = await this.sourceSql`
        SELECT
          slot_name,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) as lag_bytes
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
      `;

      for (const row of lagResult) {
        const slot = status.replicationSlots.find(s => s.name === row.slot_name);
        if (slot) {
          slot.lagBytes = parseInt(row.lag_bytes) || 0;
        }
      }

      status.databases = Array.from(this.syncedDatabases);

    } catch (err) {
      this.logger.error({ err }, 'Failed to get replication status');
      status.error = err.message;
    }

    return status;
  }

  /**
   * Graceful shutdown
   */
  async stop() {
    this.logger.info('Stopping sync manager');

    if (this.sourceSql) {
      await this.sourceSql.close();
    }

    if (this.targetSql) {
      await this.targetSql.close();
    }

    this.initialized = false;
    this.logger.info('Sync manager stopped');
  }
}
