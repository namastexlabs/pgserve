/**
 * SyncManager - Async replication from pgserve to real PostgreSQL
 *
 * Uses PostgreSQL's native logical replication for ZERO hot-path impact.
 * All replication is handled by PostgreSQL's WAL writer process, not Node.js.
 */

import pg from 'pg';
import pino from 'pino';

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

    this.logger = pino({ level: options.logLevel || 'info' }).child({ component: 'sync' });

    this.sourcePool = null;  // Connection to pgserve's PostgreSQL
    this.targetPool = null;  // Connection to real PostgreSQL
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

    // Create connection pool to source (pgserve's embedded PostgreSQL)
    const sourceConfig = this.sourceSocketPath
      ? {
          host: this.sourceSocketPath.replace(/\/\.s\.PGSQL\.\d+$/, ''),
          port: this.sourcePort,
          database: 'postgres',
          user: 'postgres',
          password: 'postgres'
        }
      : {
          host: '127.0.0.1',
          port: this.sourcePort,
          database: 'postgres',
          user: 'postgres',
          password: 'postgres'
        };

    this.sourcePool = new pg.Pool({
      ...sourceConfig,
      max: 3,  // Low pool size - replication is async, not latency-sensitive
      idleTimeoutMillis: 30000
    });

    // Create connection pool to target (real PostgreSQL)
    this.targetPool = new pg.Pool({
      connectionString: this.targetUrl,
      max: 3,
      idleTimeoutMillis: 30000
    });

    // Test connections
    try {
      await this.sourcePool.query('SELECT 1');
      this.logger.debug('Source pool connected');
    } catch (err) {
      this.logger.error({ err }, 'Failed to connect to source PostgreSQL');
      throw err;
    }

    try {
      await this.targetPool.query('SELECT 1');
      this.logger.debug('Target pool connected');
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
    const client = await this.targetPool.connect();
    try {
      const result = await client.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );

      if (result.rows.length === 0) {
        // CREATE DATABASE cannot run in transaction
        await client.query(`CREATE DATABASE "${dbName}"`);
        this.logger.debug({ dbName }, 'Created database on target');
      }
    } finally {
      client.release();
    }
  }

  /**
   * Setup publication on source (pgserve's PostgreSQL)
   * @param {string} dbName
   */
  async setupPublication(dbName) {
    // Connect to the specific database on source
    const sourceDbPool = new pg.Pool({
      host: this.sourceSocketPath
        ? this.sourceSocketPath.replace(/\/\.s\.PGSQL\.\d+$/, '')
        : '127.0.0.1',
      port: this.sourcePort,
      database: dbName,
      user: 'postgres',
      password: 'postgres',
      max: 1
    });

    try {
      const pubName = `pgserve_pub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;

      // Check if publication exists
      const result = await sourceDbPool.query(
        'SELECT 1 FROM pg_publication WHERE pubname = $1',
        [pubName]
      );

      if (result.rows.length === 0) {
        // Create publication for all tables
        await sourceDbPool.query(`CREATE PUBLICATION "${pubName}" FOR ALL TABLES`);
        this.logger.debug({ dbName, pubName }, 'Created publication on source');
      }
    } finally {
      await sourceDbPool.end();
    }
  }

  /**
   * Setup subscription on target PostgreSQL
   * @param {string} dbName
   */
  async setupSubscription(dbName) {
    // Connect to the specific database on target
    const targetUrl = new URL(this.targetUrl);
    targetUrl.pathname = `/${dbName}`;

    const targetDbPool = new pg.Pool({
      connectionString: targetUrl.toString(),
      max: 1
    });

    try {
      const subName = `pgserve_sub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;
      const pubName = `pgserve_pub_${dbName.replace(/[^a-z0-9_]/gi, '_')}`;

      // Check if subscription exists
      const result = await targetDbPool.query(
        'SELECT 1 FROM pg_subscription WHERE subname = $1',
        [subName]
      );

      if (result.rows.length === 0) {
        // Build connection string to source - ALWAYS use TCP for cross-container compatibility
        // (Unix sockets won't work when target is in Docker or remote)
        const sourceConnStr = `host=127.0.0.1 port=${this.sourcePort} dbname=${dbName} user=postgres password=postgres`;

        // Create subscription
        await targetDbPool.query(`
          CREATE SUBSCRIPTION "${subName}"
          CONNECTION '${sourceConnStr}'
          PUBLICATION "${pubName}"
          WITH (copy_data = true, create_slot = true)
        `);
        this.logger.debug({ dbName, subName }, 'Created subscription on target');
      }
    } finally {
      await targetDbPool.end();
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
      const slotsResult = await this.sourcePool.query(`
        SELECT slot_name, active, restart_lsn, confirmed_flush_lsn
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
      `);

      status.replicationSlots = slotsResult.rows.map(row => ({
        name: row.slot_name,
        active: row.active,
        restartLsn: row.restart_lsn,
        confirmedFlushLsn: row.confirmed_flush_lsn
      }));

      // Query replication lag
      const lagResult = await this.sourcePool.query(`
        SELECT
          slot_name,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) as lag_bytes
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
      `);

      for (const row of lagResult.rows) {
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

    if (this.sourcePool) {
      await this.sourcePool.end();
    }

    if (this.targetPool) {
      await this.targetPool.end();
    }

    this.initialized = false;
    this.logger.info('Sync manager stopped');
  }
}
