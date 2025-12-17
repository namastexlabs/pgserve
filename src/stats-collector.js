/**
 * Stats Collector - Centralized statistics gathering for pgserve
 *
 * Aggregates stats from:
 * - Router (active connections)
 * - PostgreSQL Manager (databases, storage)
 * - PostgreSQL internals (pg_stat_activity, pg_stat_database)
 * - Process (memory, uptime)
 */

export class StatsCollector {
  constructor(options = {}) {
    this.pgManager = options.pgManager;
    this.router = options.router;
    this.clusterStats = options.clusterStats; // Function that returns cluster stats
    this.logger = options.logger;

    // Override values for cluster mode where router is null
    this.serverPort = options.port;
    this.serverHost = options.host;

    // Cache to avoid over-querying
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = 1000; // 1 second cache

    // CPU tracking
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();

    // Disk I/O tracking (Linux)
    this.lastDiskStats = null;
    this.lastDiskTime = 0;
  }

  /**
   * Collect all available stats
   * @returns {Promise<StatsSnapshot>}
   */
  async collect() {
    // Return cached if recent
    if (this.cache && Date.now() - this.cacheTime < this.cacheTTL) {
      return this.cache;
    }

    const pgStats = this.pgManager?.getStats?.() || {};
    const routerStats = this.router?.getStats?.() || {};
    const clusterStats = this.clusterStats?.() || null;

    const snapshot = {
      timestamp: Date.now(),
      uptime: process.uptime(),

      // Connection stats
      connections: {
        active: clusterStats?.connections?.active ?? routerStats.activeConnections ?? 0,
        totalConnected: clusterStats?.connections?.totalConnected ?? 0,
        totalDisconnected: clusterStats?.connections?.totalDisconnected ?? 0,
        max: this.router?.maxConnections || 1000
      },

      // Server config
      server: {
        port: this.serverPort || routerStats.port || this.router?.port || 8432,
        host: this.serverHost || routerStats.host || this.router?.host || '127.0.0.1',
        pgPort: routerStats.pgPort || pgStats.port || 0,
        memoryMode: this.router?.memoryMode ?? !pgStats.persistent,
        useRam: this.pgManager?.useRam || false
      },

      // PostgreSQL manager stats
      postgres: {
        port: pgStats.port,
        databases: pgStats.databases || [],
        databaseDir: pgStats.databaseDir,
        socketDir: pgStats.socketDir,
        socketPath: pgStats.socketPath,
        persistent: pgStats.persistent
      },

      // Cluster stats (if in cluster mode)
      cluster: clusterStats ? {
        workers: clusterStats.workers,
        pids: clusterStats.pids,
        workerStats: clusterStats.workerStats || {}
      } : null,

      // PostgreSQL internals (pg_stat_*)
      internals: await this.collectPgStats(),

      // Process stats
      process: {
        pid: process.pid,
        memory: process.memoryUsage(),
        cpu: this.getCpuUsage()
      },

      // System stats (Linux)
      system: await this.getSystemStats()
    };

    this.cache = snapshot;
    this.cacheTime = Date.now();
    return snapshot;
  }

  /**
   * Get CPU usage percentage
   */
  getCpuUsage() {
    const now = Date.now();
    const elapsed = now - this.lastCpuTime;
    if (elapsed < 100) return this.lastCpuPercent || 0;

    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const totalMicros = cpuUsage.user + cpuUsage.system;
    const elapsedMicros = elapsed * 1000; // Convert ms to microseconds

    // CPU percentage (can be > 100% on multi-core)
    const percent = (totalMicros / elapsedMicros) * 100;

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = now;
    this.lastCpuPercent = percent;

    return Math.min(percent, 100); // Cap at 100% for display
  }

  /**
   * Get system stats (Linux-specific)
   */
  async getSystemStats() {
    const stats = {
      loadAvg: null,
      diskIO: null
    };

    try {
      // Load average (works on Linux/macOS)
      const os = await import('os');
      const loadAvg = os.loadavg();
      stats.loadAvg = {
        '1m': loadAvg[0],
        '5m': loadAvg[1],
        '15m': loadAvg[2]
      };

      // Disk I/O stats (Linux only via /proc/diskstats)
      if (process.platform === 'linux') {
        const fs = await import('fs/promises');
        try {
          const diskstats = await fs.readFile('/proc/diskstats', 'utf8');
          const now = Date.now();

          // Parse diskstats - find main disk (sda, nvme0n1, vda, etc.)
          let readSectors = 0;
          let writeSectors = 0;
          let readOps = 0;
          let writeOps = 0;

          for (const line of diskstats.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 14) continue;

            const device = parts[2];
            // Match main disks (sda, sdb, nvme0n1, vda, etc.) but not partitions
            if (/^(sd[a-z]|nvme\d+n\d+|vd[a-z])$/.test(device)) {
              readOps += parseInt(parts[3]) || 0;
              readSectors += parseInt(parts[5]) || 0;
              writeOps += parseInt(parts[7]) || 0;
              writeSectors += parseInt(parts[9]) || 0;
            }
          }

          if (this.lastDiskStats && this.lastDiskTime) {
            const elapsed = (now - this.lastDiskTime) / 1000; // seconds
            if (elapsed > 0) {
              const readDiff = readSectors - this.lastDiskStats.readSectors;
              const writeDiff = writeSectors - this.lastDiskStats.writeSectors;
              const readOpsDiff = readOps - this.lastDiskStats.readOps;
              const writeOpsDiff = writeOps - this.lastDiskStats.writeOps;

              // Sectors are typically 512 bytes
              stats.diskIO = {
                readMBps: ((readDiff * 512) / (1024 * 1024)) / elapsed,
                writeMBps: ((writeDiff * 512) / (1024 * 1024)) / elapsed,
                readIOPS: readOpsDiff / elapsed,
                writeIOPS: writeOpsDiff / elapsed
              };
            }
          }

          this.lastDiskStats = { readSectors, writeSectors, readOps, writeOps };
          this.lastDiskTime = now;
        } catch {
          // /proc/diskstats not available
        }
      }
    } catch {
      // OS module or stats not available
    }

    return stats;
  }

  /**
   * Query PostgreSQL internal statistics
   */
  async collectPgStats() {
    // Get admin pool from pgManager
    const adminPool = this.pgManager?.adminPool;
    if (!adminPool) return null;

    try {
      // Query pg_stat_activity for connection details
      const activity = await adminPool`
        SELECT
          count(*) FILTER (WHERE state = 'active') as active_queries,
          count(*) FILTER (WHERE state = 'idle') as idle_connections,
          count(*) as total_connections
        FROM pg_stat_activity
        WHERE datname IS NOT NULL
      `;

      // Query pg_stat_database for DB-level stats
      const dbStats = await adminPool`
        SELECT
          datname,
          numbackends,
          xact_commit,
          xact_rollback,
          blks_read,
          blks_hit,
          tup_returned,
          tup_fetched,
          tup_inserted,
          tup_updated,
          tup_deleted
        FROM pg_stat_database
        WHERE datname NOT IN ('template0', 'template1')
        ORDER BY numbackends DESC
        LIMIT 10
      `;

      return {
        activity: activity[0] || {},
        databases: dbStats || []
      };
    } catch (err) {
      this.logger?.debug?.({ err: err.message }, 'Failed to collect pg_stat_*');
      return null;
    }
  }
}
