/**
 * @namastexlabs/pglite-embedded-server
 *
 * Multi-tenant PostgreSQL router using PGlite
 * Single port, auto-provisioning, perfect for multi-user apps and AI agents
 */

// Multi-tenant mode (NEW - recommended)
export { MultiTenantRouter, startMultiTenantServer } from './router.js';
export { InstancePool } from './pool.js';

// Legacy single-instance mode (backwards compatible)
import { startServer as _startServer, stopServer as _stopServer } from './server.js';
import { allocatePort, getPortRangeInfo } from './ports.js';
import {
  findInstanceByDataDir,
  findInstanceByPort,
  listInstances,
  cleanupStaleInstances
} from './registry.js';
import { autoDetect as _autoDetect } from './detector.js';

/**
 * Start a new PGlite server instance
 *
 * @param {Object} options
 * @param {string} options.dataDir - Data directory for the database
 * @param {number} [options.port] - Specific port (optional, auto-allocated if not provided)
 * @param {boolean} [options.autoPort=true] - Auto-allocate port if specified port is unavailable
 * @param {string} [options.logLevel='info'] - Log level (error, warn, info, debug)
 * @returns {Promise<Object>} Server instance
 */
export async function startServer({ dataDir, port, autoPort = true, logLevel = 'info' }) {
  // Allocate port (checks for existing instance, reuses if running)
  const allocatedPort = await allocatePort(dataDir, port);

  if (port && allocatedPort !== port && !autoPort) {
    throw new Error(
      `Port ${port} unavailable and autoPort is disabled. ` +
        `Use autoPort: true or choose a different port.`
    );
  }

  return _startServer({ dataDir, port: allocatedPort, logLevel });
}

/**
 * Stop a running server instance
 *
 * @param {Object} options
 * @param {string} [options.dataDir] - Data directory of the instance to stop
 * @param {number} [options.port] - Port of the instance to stop
 */
export async function stopServer({ dataDir, port }) {
  return _stopServer({ dataDir, port });
}

/**
 * Get an existing instance or start a new one
 *
 * This is the recommended way to start a server, as it prevents
 * duplicate instances for the same data directory.
 *
 * @param {Object} options
 * @param {string} options.dataDir - Data directory for the database
 * @param {number} [options.port] - Preferred port (auto-allocated if unavailable)
 * @param {boolean} [options.autoPort=true] - Auto-allocate port
 * @param {string} [options.logLevel='info'] - Log level
 * @returns {Promise<Object>} Server instance (existing or new)
 */
export async function getOrStart({ dataDir, port, autoPort = true, logLevel = 'info' }) {
  // Check if instance already running
  const existing = findInstanceByDataDir(dataDir);

  if (existing) {
    // Verify process is still alive
    try {
      process.kill(existing.pid, 0);
      console.log(`✅ Using existing instance on port ${existing.port}`);

      return {
        port: existing.port,
        dataDir,
        pid: existing.pid,
        connectionUrl: `postgresql://localhost:${existing.port}`,
        existing: true
      };
    } catch {
      // Process dead, cleanup and start new
      console.log('🔄 Stale instance found, starting fresh...');
    }
  }

  // Start new instance
  return startServer({ dataDir, port, autoPort, logLevel });
}

/**
 * Auto-detect database configuration
 *
 * Tries external PostgreSQL first, falls back to embedded PGlite
 *
 * @param {Object} options
 * @param {string} [options.externalUrl] - External PostgreSQL URL to try first
 * @param {string} options.embeddedDataDir - Data directory for embedded fallback
 * @param {number} [options.embeddedPort] - Preferred port for embedded server
 * @param {number} [options.timeout=5000] - Timeout for external connection test
 * @returns {Promise<Object>} Database configuration
 */
export async function autoDetect({
  externalUrl,
  embeddedDataDir,
  embeddedPort,
  timeout = 5000
}) {
  return _autoDetect({ externalUrl, embeddedDataDir, embeddedPort, timeout });
}

/**
 * List all running instances
 *
 * @returns {Array<Object>} Array of instance info
 */
export function list() {
  return listInstances();
}

/**
 * Find instance by data directory
 *
 * @param {string} dataDir - Data directory path
 * @returns {Object|null} Instance info or null
 */
export function findByDataDir(dataDir) {
  return findInstanceByDataDir(dataDir);
}

/**
 * Find instance by port
 *
 * @param {number} port - Port number
 * @returns {Object|null} Instance info or null
 */
export function findByPort(port) {
  return findInstanceByPort(port);
}

/**
 * Get port range information
 *
 * @returns {Object} Port range stats
 */
export function portInfo() {
  return getPortRangeInfo();
}

/**
 * Cleanup stale instances (dead processes)
 *
 * @returns {number} Number of instances cleaned up
 */
export function cleanup() {
  return cleanupStaleInstances();
}

// Export all functions
export default {
  startServer,
  stopServer,
  getOrStart,
  autoDetect,
  list,
  findByDataDir,
  findByPort,
  portInfo,
  cleanup
};
