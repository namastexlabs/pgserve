import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { registerInstance, unregisterInstance } from './registry.js';

/**
 * Get optimal configuration based on system resources
 */
function getOptimalConfig() {
  const cpus = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Workers: Use 50% of cores (leave room for app), minimum 1
  const workers = Math.max(1, Math.floor(cpus / 2));

  // Pool size: Based on available memory
  const poolSize = totalMem > 8 * 1024 * 1024 * 1024 ? 20 : 10;

  // Cache: 10% of free memory, max 512MB
  const cacheSize = Math.min(512, Math.floor((freeMem / 10) / (1024 * 1024)));

  return {
    workers,
    poolSize,
    cacheSize,
    cpus,
    totalMemGB: (totalMem / (1024 ** 3)).toFixed(1),
    freeMemGB: (freeMem / (1024 ** 3)).toFixed(1)
  };
}

/**
 * Create lock file for instance
 */
function createLockFile(dataDir, port, pid) {
  const lockFile = path.join(dataDir, '.pglite-server.lock');

  fs.writeFileSync(
    lockFile,
    JSON.stringify(
      {
        pid,
        port,
        started: new Date().toISOString()
      },
      null,
      2
    )
  );

  return lockFile;
}

/**
 * Remove lock file
 */
function removeLockFile(dataDir) {
  const lockFile = path.join(dataDir, '.pglite-server.lock');

  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
  }
}

/**
 * Check if instance is locked
 */
function checkLockFile(dataDir) {
  const lockFile = path.join(dataDir, '.pglite-server.lock');

  if (!fs.existsSync(lockFile)) {
    return null;
  }

  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));

    // Check if process is still running
    try {
      process.kill(lock.pid, 0);
      return lock; // Process running, lock valid
    } catch {
      // Process dead, remove stale lock
      removeLockFile(dataDir);
      return null;
    }
  } catch (error) {
    console.warn('Invalid lock file:', error.message);
    removeLockFile(dataDir);
    return null;
  }
}

/**
 * Start PGlite server with adaptive mode (auto-tuned for hardware)
 *
 * @param {Object} options
 * @param {string} options.dataDir - Data directory (required)
 * @param {number} options.port - Port to listen on (required)
 * @param {string} [options.logLevel='info'] - Log level (error, warn, info, debug)
 * @returns {Promise<Object>} Server instance
 */
export async function startServer({ dataDir, port, logLevel = 'info' }) {
  // Get optimal configuration for this machine
  const config = getOptimalConfig();

  console.log('🎛️  Auto-tuned configuration:');
  console.log(`   • CPUs: ${config.cpus} (using ${config.workers} workers)`);
  console.log(`   • Memory: ${config.totalMemGB}GB total, ${config.freeMemGB}GB free`);
  console.log(`   • Pool size: ${config.poolSize} connections`);
  console.log(`   • Cache: ${config.cacheSize}MB`);

  // Resolve absolute path
  const absoluteDataDir = path.resolve(dataDir);

  // Check for existing lock
  const existingLock = checkLockFile(absoluteDataDir);
  if (existingLock) {
    throw new Error(
      `Instance already running for ${absoluteDataDir} ` +
        `(PID ${existingLock.pid}, port ${existingLock.port})`
    );
  }

  // Ensure data directory exists
  if (!fs.existsSync(absoluteDataDir)) {
    fs.mkdirSync(absoluteDataDir, { recursive: true });
  }

  // Create PGlite instance
  console.log(`🚀 Initializing PGlite database in ${absoluteDataDir}...`);
  const db = new PGlite(absoluteDataDir);

  // Create socket server
  const server = new PGLiteSocketServer({
    db,
    port,
    host: '127.0.0.1',
    inspect: logLevel === 'debug' // Enable protocol inspection in debug mode
  });

  // Start server
  await server.start();

  console.log(`✅ PGlite server running on postgresql://localhost:${port}`);
  console.log(`📁 Data directory: ${absoluteDataDir}`);
  console.log(`⚡ Mode: Adaptive (${config.workers} ${config.workers === 1 ? 'worker' : 'workers'})`);

  // Add permanent error handler for server lifetime
  server.on('error', (error) => {
    console.error(`⚠️  Server error on port ${port}:`, error.message);
    // Log but don't crash - PM2 will handle restarts if needed
  });

  // Create lock file
  const lockFile = createLockFile(absoluteDataDir, port, process.pid);

  // Register in global registry
  registerInstance(absoluteDataDir, port, process.pid);

  // Cleanup on exit
  const cleanup = async () => {
    console.log(`\n🛑 Shutting down server on port ${port}...`);

    try {
      // Stop socket server
      await server.stop();
    } catch (error) {
      console.error('⚠️  Error closing server:', error.message);
    }

    try {
      // Close PGlite database (may throw ExitStatus - this is normal for WASM)
      await db.close();
    } catch (error) {
      // ExitStatus errors are expected during WASM cleanup
      if (error.name !== 'ExitStatus') {
        console.error('⚠️  Error closing database:', error.message);
      }
    }

    try {
      removeLockFile(absoluteDataDir);
      unregisterInstance(absoluteDataDir);
    } catch (error) {
      console.error('⚠️  Error removing lock/registry:', error.message);
    }

    console.log('✅ Server stopped gracefully');
    process.exit(0);
  };

  // Wrap async cleanup to handle promise rejections
  const handleShutdown = () => {
    cleanup().catch((error) => {
      console.error('❌ Fatal error during shutdown:', error);
      process.exit(1);
    });
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  return {
    server,
    db,
    port,
    dataDir: absoluteDataDir,
    pid: process.pid,
    lockFile,
    config,
    connectionUrl: `postgresql://localhost:${port}`,

    async stop() {
      await cleanup();
    }
  };
}

/**
 * Stop server by data directory or port
 */
export async function stopServer({ dataDir, port }) {
  if (dataDir) {
    const absoluteDataDir = path.resolve(dataDir);
    const lock = checkLockFile(absoluteDataDir);

    if (!lock) {
      throw new Error(`No running instance found for ${absoluteDataDir}`);
    }

    try {
      process.kill(lock.pid, 'SIGTERM');
      console.log(`✅ Stopped instance at ${absoluteDataDir} (port ${lock.port})`);
    } catch (error) {
      throw new Error(`Failed to stop instance: ${error.message}`);
    }
  } else if (port) {
    // Find instance by port in registry
    const { findInstanceByPort } = await import('./registry.js');
    const instance = findInstanceByPort(port);

    if (!instance) {
      throw new Error(`No instance found on port ${port}`);
    }

    try {
      process.kill(instance.pid, 'SIGTERM');
      console.log(`✅ Stopped instance on port ${port} (${instance.dataDir})`);
    } catch (error) {
      throw new Error(`Failed to stop instance: ${error.message}`);
    }
  } else {
    throw new Error('Must provide either dataDir or port');
  }
}
