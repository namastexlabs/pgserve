/**
 * Stats Dashboard - Real-time CLI monitoring display for pgserve
 *
 * htop-style in-place terminal updates showing:
 * - Server info (endpoint, mode, uptime)
 * - Connections (active, total, with progress bar)
 * - Cluster workers (if in cluster mode)
 * - PostgreSQL (databases, internal port)
 * - PG Internals (backends, cache hit ratio)
 * - Memory usage
 *
 * Supports TTY and non-TTY environments.
 */

// ANSI escape codes
const ANSI = {
  CLEAR_LINE: '\x1B[2K',
  MOVE_UP: (n) => `\x1B[${n}A`,
  HIDE_CURSOR: '\x1B[?25l',
  SHOW_CURSOR: '\x1B[?25h',

  // Colors
  GREEN: '\x1B[32m',
  YELLOW: '\x1B[33m',
  CYAN: '\x1B[36m',
  RED: '\x1B[31m',
  MAGENTA: '\x1B[35m',
  DIM: '\x1B[2m',
  RESET: '\x1B[0m',
  BOLD: '\x1B[1m',
  INVERSE: '\x1B[7m'
};

// Color thresholds for progress bars and values (percentage of max)
const THRESHOLD_WARN = 0.6;    // Yellow at 60%
const THRESHOLD_CRITICAL = 0.8; // Red at 80%

export class StatsDashboard {
  /**
   * @param {Object} options
   * @param {number} [options.refreshInterval=2000] - Dashboard refresh interval in ms
   * @param {() => Promise<StatsSnapshot>} [options.statsProvider] - Async function returning stats object
   * @param {() => void} [options.onStop] - Callback when dashboard stops
   */
  constructor(options = {}) {
    // Respects NO_COLOR env var (https://no-color.org/ standard)
    this.enabled = process.stdout.isTTY && !process.env.NO_COLOR;
    // Default 2s refresh for real-time feel (trade-off: higher CPU vs fresher data)
    this.refreshInterval = options.refreshInterval || 2000;
    this.statsProvider = options.statsProvider;
    this.timer = null;
    this.displayLines = 0;
    this.lastStats = null;
    this.startTime = Date.now();
    this.onStop = options.onStop; // Optional callback when dashboard stops
  }

  /**
   * Start the dashboard refresh loop
   */
  start() {
    if (!this.enabled) {
      console.log('[Stats Dashboard disabled - non-TTY environment]');
      return;
    }

    // Hide cursor during dashboard display
    process.stdout.write(ANSI.HIDE_CURSOR);

    // Initial render
    this.render();

    // Start refresh timer
    this.timer = setInterval(() => this.render(), this.refreshInterval);

    // Handle terminal resize
    process.stdout.on('resize', () => this.render());

    // Ensure cursor is restored on exit
    const cleanup = () => {
      this.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  /**
   * Stop the dashboard
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) {
      process.stdout.write(ANSI.SHOW_CURSOR);
      // Move below dashboard area
      if (this.displayLines > 0) {
        console.log('\n');
      }
    }
    if (this.onStop) {
      this.onStop();
    }
  }

  /**
   * Render the dashboard
   */
  async render() {
    if (!this.statsProvider) return;

    try {
      const stats = await this.statsProvider();
      this.lastStats = stats;
      this.draw(stats);
    } catch (err) {
      // Don't crash on stats collection failure - use cached stats if available
      // Only log once to avoid spam during persistent issues
      if (!this._lastError || this._lastError !== err.message) {
        this._lastError = err.message;
        console.error(`[stats] Collection failed: ${err.message}`);
      }
      if (this.lastStats) {
        this.draw(this.lastStats);
      }
    }
  }

  /**
   * Draw the dashboard to terminal
   */
  draw(stats) {
    const output = this.buildDisplay(stats);

    // Count actual lines (including newlines within sections)
    const totalLines = output.split('\n').length;

    // Clear previous output and redraw
    if (this.displayLines > 0) {
      process.stdout.write(ANSI.MOVE_UP(this.displayLines));
    }

    // Write each line with clear
    for (const line of output.split('\n')) {
      process.stdout.write(ANSI.CLEAR_LINE + line + '\n');
    }

    this.displayLines = totalLines;
  }

  /**
   * Build the display lines
   */
  buildDisplay(stats) {
    const lines = [];
    // Use actual terminal width (no arbitrary cap - users with wide terminals get wider display)
    const width = process.stdout.columns || 80;

    // Header bar
    lines.push(this.headerBar(width));
    lines.push('');

    // Server info section
    // Determine storage mode label
    let modeLabel = 'Persistent';
    if (stats.server?.memoryMode) {
      modeLabel = stats.server?.useRam ? 'RAM (/dev/shm)' : 'Ephemeral (temp)';
    }

    lines.push(this.section('SERVER', [
      `${ANSI.DIM}Endpoint:${ANSI.RESET}  postgresql://${stats.server?.host || '127.0.0.1'}:${stats.server?.port || 8432}/<db>`,
      `${ANSI.DIM}Mode:${ANSI.RESET}      ${modeLabel}`,
      `${ANSI.DIM}Uptime:${ANSI.RESET}    ${this.formatUptime(stats.uptime || 0)}`
    ]));
    lines.push('');

    // Connections section
    const connActive = stats.connections?.active || 0;
    const connMax = stats.connections?.max || 1000;
    const connTotal = stats.connections?.totalConnected || 0;
    const connDisc = stats.connections?.totalDisconnected || 0;

    const connLines = [
      `${ANSI.DIM}Active:${ANSI.RESET}    ${this.colorValue(connActive, connMax * THRESHOLD_WARN, connMax * THRESHOLD_CRITICAL)} / ${connMax}  ${this.miniBar(connActive, connMax, 20)}`
    ];

    if (connTotal > 0 || connDisc > 0) {
      connLines.push(`${ANSI.DIM}Total:${ANSI.RESET}     ${this.formatNumber(connTotal)} connected, ${this.formatNumber(connDisc)} disconnected`);
    }

    lines.push(this.section('CONNECTIONS', connLines));
    lines.push('');

    // Cluster section (if applicable)
    if (stats.cluster && stats.cluster.workers > 0) {
      const workerLines = [`${ANSI.DIM}Workers:${ANSI.RESET}   ${stats.cluster.workers} processes`];

      if (stats.cluster.workerStats && Object.keys(stats.cluster.workerStats).length > 0) {
        const workerEntries = Object.entries(stats.cluster.workerStats);
        // Show up to 4 workers inline
        for (const [id, ws] of workerEntries.slice(0, 4)) {
          workerLines.push(`  ${ANSI.DIM}Worker ${id}:${ANSI.RESET} ${ws.connections || 0} conn (PID ${ws.pid})`);
        }
        if (workerEntries.length > 4) {
          workerLines.push(`  ${ANSI.DIM}... and ${workerEntries.length - 4} more workers${ANSI.RESET}`);
        }
      }

      lines.push(this.section('CLUSTER', workerLines));
      lines.push('');
    }

    // PostgreSQL section
    if (stats.postgres) {
      const pgLines = [
        `${ANSI.DIM}Internal Port:${ANSI.RESET} ${stats.postgres.port || 'N/A'}`,
        `${ANSI.DIM}Databases:${ANSI.RESET}     ${stats.postgres.databases?.length || 0}`
      ];

      // Show database list if not too many
      const dbs = stats.postgres.databases || [];
      if (dbs.length > 0 && dbs.length <= 5) {
        pgLines.push(`  ${ANSI.DIM}${ANSI.RESET} ${dbs.join(', ')}`);
      } else if (dbs.length > 5) {
        pgLines.push(`  ${ANSI.DIM}${ANSI.RESET} ${dbs.slice(0, 5).join(', ')}${ANSI.DIM}... (+${dbs.length - 5})${ANSI.RESET}`);
      }

      lines.push(this.section('POSTGRESQL', pgLines));
      lines.push('');
    }

    // PostgreSQL Internals section (pg_stat_*)
    if (stats.internals) {
      const intLines = [];

      if (stats.internals.activity) {
        const a = stats.internals.activity;
        intLines.push(`${ANSI.DIM}Backends:${ANSI.RESET}      ${a.total_connections || 0} total, ${a.active_queries || 0} active, ${a.idle_connections || 0} idle`);
      }

      if (stats.internals.databases?.length > 0) {
        intLines.push(`${ANSI.DIM}Top DBs by connections:${ANSI.RESET}`);
        for (const db of stats.internals.databases.slice(0, 3)) {
          // Use BigInt for precision on high-traffic systems (PostgreSQL returns 8-byte integers)
          const blksHit = BigInt(db.blks_hit || 0);
          const blksRead = BigInt(db.blks_read || 0);
          const total = blksHit + blksRead;
          // Calculate ratio safely: multiply by 1000 first, then convert to Number for final formatting
          const hitRatio = total > 0n
            ? (Number((blksHit * 1000n) / total) / 10).toFixed(1)
            : '0.0';
          intLines.push(`  ${ANSI.CYAN}${db.datname}${ANSI.RESET}: ${db.numbackends} conn, ${hitRatio}% cache hit`);
        }
      }

      if (intLines.length > 0) {
        lines.push(this.section('PG INTERNALS', intLines));
        lines.push('');
      }
    }

    // System resources section
    const resourceLines = [];

    // CPU usage
    if (stats.process?.cpu !== undefined) {
      const cpuPct = stats.process.cpu;
      resourceLines.push(`${ANSI.DIM}CPU:${ANSI.RESET}       ${cpuPct.toFixed(1)}%  ${this.miniBar(cpuPct, 100, 15)}`);
    }

    // Load average
    if (stats.system?.loadAvg) {
      const load = stats.system.loadAvg;
      resourceLines.push(`${ANSI.DIM}Load Avg:${ANSI.RESET}  ${load['1m'].toFixed(2)} / ${load['5m'].toFixed(2)} / ${load['15m'].toFixed(2)}`);
    }

    // Memory
    if (stats.process?.memory) {
      const mem = stats.process.memory;
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
      resourceLines.push(`${ANSI.DIM}Memory:${ANSI.RESET}    ${rssMB} MB RSS`);
    }

    // Disk I/O
    if (stats.system?.diskIO) {
      const io = stats.system.diskIO;
      const readSpeed = io.readMBps.toFixed(1);
      const writeSpeed = io.writeMBps.toFixed(1);
      const readIOPS = io.readIOPS.toFixed(0);
      const writeIOPS = io.writeIOPS.toFixed(0);
      resourceLines.push(`${ANSI.DIM}Disk I/O:${ANSI.RESET}  R: ${readSpeed} MB/s (${readIOPS} IOPS) | W: ${writeSpeed} MB/s (${writeIOPS} IOPS)`);
    }

    if (resourceLines.length > 0) {
      lines.push(this.section('RESOURCES', resourceLines));
      lines.push('');
    }

    // Footer
    lines.push(`${ANSI.DIM}Last update: ${new Date().toLocaleTimeString()} | Refresh: ${this.refreshInterval / 1000}s | Press Ctrl+C to exit${ANSI.RESET}`);

    return lines.join('\n');
  }

  /**
   * Render header bar
   */
  headerBar(width) {
    const title = ' pgserve stats ';
    const padding = Math.max(0, Math.floor((width - title.length) / 2));
    const rightPad = Math.max(0, width - padding - title.length);
    return `${ANSI.INVERSE}${' '.repeat(padding)}${title}${' '.repeat(rightPad)}${ANSI.RESET}`;
  }

  /**
   * Render a section with title and lines
   */
  section(title, contentLines) {
    const header = `${ANSI.BOLD}${ANSI.CYAN}[${title}]${ANSI.RESET}`;
    return [header, ...contentLines.map(l => '  ' + l)].join('\n');
  }

  /**
   * Color a value based on thresholds
   */
  colorValue(value, warnThreshold, errorThreshold) {
    if (value >= errorThreshold) {
      return `${ANSI.RED}${value}${ANSI.RESET}`;
    } else if (value >= warnThreshold) {
      return `${ANSI.YELLOW}${value}${ANSI.RESET}`;
    }
    return `${ANSI.GREEN}${value}${ANSI.RESET}`;
  }

  /**
   * Render mini progress bar
   */
  miniBar(current, max, width = 10) {
    // Ensure valid numbers
    const safeMax = Math.max(1, Number(max) || 1);
    const safeCurrent = Math.max(0, Math.min(Number(current) || 0, safeMax));

    const pct = safeCurrent / safeMax;
    // filled is clamped to [0, width], so (width - filled) is always non-negative
    const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
    const empty = width - filled;

    let color = ANSI.GREEN;
    if (pct > THRESHOLD_CRITICAL) color = ANSI.RED;
    else if (pct > THRESHOLD_WARN) color = ANSI.YELLOW;

    // Use Unicode block characters for progress bar
    const filledChar = '\u2588'; // Full block
    const emptyChar = '\u2591';  // Light shade

    return `${color}[${filledChar.repeat(filled)}${ANSI.DIM}${emptyChar.repeat(empty)}${ANSI.RESET}${color}]${ANSI.RESET}`;
  }

  /**
   * Format uptime as human-readable string
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  /**
   * Format large numbers with commas
   */
  formatNumber(num) {
    return num.toLocaleString();
  }
}
