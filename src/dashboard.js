/**
 * Dashboard - Informative CLI startup display
 *
 * Hybrid approach:
 * - Scrolling stages (preserved history)
 * - In-place progress updates (only during restore)
 * - Non-TTY fallback (works in pipes/CI)
 *
 * Zero external dependencies - pure Node.js ANSI codes
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get package version - BUILD_VERSION is injected at compile time via --define
// Falls back to reading package.json for development mode
let version = '1.0.0';
try {
  // Check for build-time injected version first
  if (typeof BUILD_VERSION !== 'undefined') {
    version = BUILD_VERSION;
  } else {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    version = pkg.version;
  }
} catch {
  // Fallback version
}

// ANSI escape codes
const ANSI = {
  CLEAR_LINE: '\x1B[2K',
  MOVE_UP: (n) => `\x1B[${n}A`,
  MOVE_DOWN: (n) => `\x1B[${n}B`,
  HIDE_CURSOR: '\x1B[?25l',
  SHOW_CURSOR: '\x1B[?25h',
  GREEN: '\x1B[32m',
  YELLOW: '\x1B[33m',
  CYAN: '\x1B[36m',
  DIM: '\x1B[2m',
  RESET: '\x1B[0m',
  BOLD: '\x1B[1m'
};

/**
 * Dashboard class for CLI output
 */
export class Dashboard {
  constructor(options = {}) {
    this.enabled = process.stdout.isTTY && !process.env.NO_COLOR;
    this.updateInterval = options.updateInterval || 200; // Throttle updates
    this.lastUpdate = 0;
    this.progressLines = 0; // Track lines to overwrite
    this.restoreStartTime = 0;
    this.config = options.config || {};
  }

  /**
   * Show the startup header
   */
  showHeader(config = {}) {
    const mode = config.memoryMode ? 'In-memory' : 'Persistent';
    const port = config.port || 8432;
    const host = config.host || '127.0.0.1';
    const syncTo = config.syncTo ? ` → ${this._maskUrl(config.syncTo)}` : '';

    console.log('');
    console.log(`${ANSI.BOLD}pgserve v${version}${ANSI.RESET} - Embedded PostgreSQL Server`);
    console.log(`${ANSI.DIM}MODE: ${mode}  |  PORT: ${port}  |  HOST: ${host}${syncTo}${ANSI.RESET}`);
    console.log('');
  }

  /**
   * Log a stage completion
   */
  stage(name, status = 'done') {
    const icon = status === 'done' ? `${ANSI.GREEN}[✓]${ANSI.RESET}` :
                 status === 'error' ? `${ANSI.YELLOW}[✗]${ANSI.RESET}` :
                 `${ANSI.DIM}[○]${ANSI.RESET}`;
    console.log(`${icon} ${name}`);
  }

  /**
   * Start restore progress section
   */
  startRestore(totalDatabases, totalTables = 0, totalBytes = 0) {
    this.restoreStartTime = Date.now();
    this.totalDatabases = totalDatabases;
    this.totalTables = totalTables || totalDatabases * 10; // Estimate
    this.totalBytes = totalBytes;

    console.log('');
    console.log(`${ANSI.CYAN}Restoring from external PostgreSQL...${ANSI.RESET}`);

    if (this.enabled) {
      // Reserve lines for progress
      console.log('  Databases:  0/0   [░░░░░░░░░░░░░░░░]   0%');
      console.log('  Tables:     0/0   [░░░░░░░░░░░░░░░░]   0%');
      console.log('  Speed:      0.0 MB/s  |  ETA: calculating...');
      this.progressLines = 3;
      process.stdout.write(ANSI.HIDE_CURSOR);
    }
  }

  /**
   * Update restore progress (in-place)
   */
  updateRestore(metrics) {
    if (!this.enabled) return;

    // Throttle updates
    const now = Date.now();
    if (now - this.lastUpdate < this.updateInterval) return;
    this.lastUpdate = now;

    const {
      databasesRestored = 0,
      totalDatabases = this.totalDatabases || 1,
      tablesRestored = 0,
      totalTables = this.totalTables || 1,
      bytesTransferred = 0
    } = metrics;

    // Calculate throughput and ETA
    const elapsed = (now - this.restoreStartTime) / 1000;
    const throughputMBps = elapsed > 0 ? (bytesTransferred / 1024 / 1024) / elapsed : 0;
    const bytesRemaining = this.totalBytes - bytesTransferred;
    const eta = throughputMBps > 0 ? Math.ceil(bytesRemaining / (throughputMBps * 1024 * 1024)) : 0;

    // Format progress
    const dbPct = Math.round((databasesRestored / totalDatabases) * 100);
    const tablePct = Math.round((tablesRestored / totalTables) * 100);
    const dbBar = this._progressBar(databasesRestored, totalDatabases);
    const tableBar = this._progressBar(tablesRestored, totalTables);
    const etaStr = eta > 0 ? `~${eta}s` : 'finishing...';

    // Move up and overwrite
    process.stdout.write(ANSI.MOVE_UP(this.progressLines));

    process.stdout.write(ANSI.CLEAR_LINE);
    console.log(`  Databases:  ${String(databasesRestored).padStart(2)}/${totalDatabases}   ${dbBar}  ${String(dbPct).padStart(3)}%`);

    process.stdout.write(ANSI.CLEAR_LINE);
    console.log(`  Tables:     ${String(tablesRestored).padStart(3)}/${totalTables}  ${tableBar}  ${String(tablePct).padStart(3)}%`);

    process.stdout.write(ANSI.CLEAR_LINE);
    console.log(`  Speed:      ${throughputMBps.toFixed(1)} MB/s  |  ETA: ${etaStr}`);
  }

  /**
   * Complete restore progress (replace with summary)
   */
  completeRestore(metrics) {
    if (this.enabled && this.progressLines > 0) {
      // Move up and clear progress lines
      process.stdout.write(ANSI.MOVE_UP(this.progressLines));
      for (let i = 0; i < this.progressLines; i++) {
        process.stdout.write(ANSI.CLEAR_LINE + '\n');
      }
      process.stdout.write(ANSI.MOVE_UP(this.progressLines));
      process.stdout.write(ANSI.SHOW_CURSOR);
      this.progressLines = 0;
    }

    const duration = ((metrics.endTime || Date.now()) - this.restoreStartTime) / 1000;
    const mb = (metrics.bytesTransferred / 1024 / 1024).toFixed(1);

    console.log(`${ANSI.GREEN}[✓]${ANSI.RESET} Restored ${metrics.databasesRestored} database${metrics.databasesRestored !== 1 ? 's' : ''} (${mb} MB in ${duration.toFixed(1)}s)`);
    console.log('');
  }

  /**
   * Show final ready message
   */
  showReady(config = {}) {
    const port = config.port || 8432;
    const host = config.host || '127.0.0.1';

    console.log('');
    console.log(`${ANSI.GREEN}${ANSI.BOLD}✨ READY${ANSI.RESET}: postgresql://${host}:${port}/<database>`);
    console.log(`${ANSI.DIM}Press Ctrl+C to stop${ANSI.RESET}`);
    console.log('');
  }

  /**
   * Generate progress bar
   */
  _progressBar(current, total, width = 16) {
    const pct = total > 0 ? current / total : 0;
    const filled = Math.round(pct * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  /**
   * Mask sensitive URL parts
   */
  _maskUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}/${u.pathname.split('/')[1] || ''}`;
    } catch {
      return url.replace(/:[^:@]+@/, ':***@');
    }
  }

  /**
   * Cleanup (show cursor if hidden)
   */
  cleanup() {
    if (this.enabled) {
      process.stdout.write(ANSI.SHOW_CURSOR);
    }
  }
}
