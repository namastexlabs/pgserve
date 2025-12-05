/**
 * PostgreSQL Manager (Direct Binary Execution)
 *
 * Manages an embedded PostgreSQL instance with true concurrent connections.
 * Directly executes PostgreSQL binaries from embedded-postgres packages,
 * bypassing the embedded-postgres library's locale-dependent initialization.
 *
 * Features:
 * - Uses embedded-postgres binaries (auto-downloaded via npm)
 * - Memory mode (default) or persistent storage
 * - True concurrent connections (native PostgreSQL process forking)
 * - Auto-provision databases on demand
 * - No locale dependency (works on any system)
 */

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import net from 'net';

// Resolve binary paths from embedded-postgres platform packages
function getBinaryPaths() {
  const platform = os.platform();
  const arch = os.arch();

  let pkgName;
  if (platform === 'linux' && arch === 'x64') {
    pkgName = '@embedded-postgres/linux-x64';
  } else if (platform === 'darwin' && arch === 'arm64') {
    pkgName = '@embedded-postgres/darwin-arm64';
  } else if (platform === 'darwin' && arch === 'x64') {
    pkgName = '@embedded-postgres/darwin-x64';
  } else if (platform === 'win32' && arch === 'x64') {
    pkgName = '@embedded-postgres/win32-x64';
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Find the package in node_modules
  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', pkgName, 'native', 'bin'),
    path.join(import.meta.dirname, '..', 'node_modules', pkgName, 'native', 'bin'),
  ];

  for (const binDir of possiblePaths) {
    const initdb = path.join(binDir, platform === 'win32' ? 'initdb.exe' : 'initdb');
    const postgres = path.join(binDir, platform === 'win32' ? 'postgres.exe' : 'postgres');
    if (fs.existsSync(initdb) && fs.existsSync(postgres)) {
      return { initdb, postgres, binDir };
    }
  }

  throw new Error(`Could not find PostgreSQL binaries. Please run: npm install ${pkgName}`);
}

export class PostgresManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || null; // null = memory mode (temp dir)
    this.port = options.port || 5433; // Internal PG port (router listens on different port)
    this.user = options.user || 'postgres';
    this.password = options.password || 'postgres';
    this.logger = options.logger;
    this.process = null;
    this.databaseDir = null;
    this.persistent = !!options.dataDir;
    this.createdDatabases = new Set();
    this.binaries = null;
    this.creatingDatabases = new Map(); // Track in-progress creations
  }

  /**
   * Start the embedded PostgreSQL instance
   */
  async start() {
    // Get binary paths
    this.binaries = getBinaryPaths();

    // Make binaries executable
    await fs.promises.chmod(this.binaries.initdb, '755');
    await fs.promises.chmod(this.binaries.postgres, '755');

    // Determine data directory
    if (this.persistent) {
      this.databaseDir = this.dataDir;
      // Ensure directory exists
      if (!fs.existsSync(this.databaseDir)) {
        fs.mkdirSync(this.databaseDir, { recursive: true });
      }
    } else {
      // Memory mode: use temp directory with unique suffix
      this.databaseDir = path.join(os.tmpdir(), `pgserve-${process.pid}-${Date.now()}`);
      // Clean up if exists from a previous failed run
      if (fs.existsSync(this.databaseDir)) {
        fs.rmSync(this.databaseDir, { recursive: true, force: true });
      }
    }

    this.logger.info({
      databaseDir: this.databaseDir,
      persistent: this.persistent,
      port: this.port
    }, 'Starting embedded PostgreSQL');

    // Check if data directory is already initialized
    const pgVersionFile = path.join(this.databaseDir, 'PG_VERSION');
    if (!fs.existsSync(pgVersionFile)) {
      await this._runInitDb();
    } else {
      this.logger.debug({ databaseDir: this.databaseDir }, 'Using existing data directory');
    }

    // Start PostgreSQL server
    await this._startPostgres();

    this.logger.info({
      databaseDir: this.databaseDir,
      port: this.port,
      persistent: this.persistent
    }, 'PostgreSQL started successfully');

    return this;
  }

  /**
   * Run initdb to initialize the data directory
   */
  async _runInitDb() {
    // Create password file
    const randomId = crypto.randomBytes(6).toString('hex');
    const passwordFile = path.join(os.tmpdir(), `pg-password-${randomId}`);
    await fs.promises.writeFile(passwordFile, this.password + '\n');

    this.logger.debug({ databaseDir: this.databaseDir }, 'Initializing PostgreSQL data directory');

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaries.initdb, [
        `--pgdata=${this.databaseDir}`,
        '--auth=password',
        `--username=${this.user}`,
        `--pwfile=${passwordFile}`,
      ], {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', async (code) => {
        // Clean up password file
        try {
          await fs.promises.unlink(passwordFile);
        } catch (e) {
          // Ignore
        }

        if (code === 0) {
          this.logger.debug('initdb completed successfully');
          resolve();
        } else {
          this.logger.error({ code, stdout, stderr }, 'initdb failed');
          reject(new Error(`initdb failed with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn initdb: ${err.message}`));
      });
    });
  }

  /**
   * Start the PostgreSQL server process
   */
  async _startPostgres() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.binaries.postgres, [
        '-D', this.databaseDir,
        '-p', this.port.toString(),
        '-k', '', // Disable unix socket (we use TCP only)
      ], {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      });

      let started = false;
      let startupOutput = '';

      const onData = (data) => {
        const message = data.toString();
        startupOutput += message;
        this.logger.debug({ pgOutput: message.trim() }, 'PostgreSQL output');

        // Check for ready message
        if (message.includes('database system is ready to accept connections') ||
            message.includes('ready to accept connections')) {
          started = true;
          resolve();
        }
      };

      this.process.stderr.on('data', onData);
      this.process.stdout.on('data', onData);

      this.process.on('close', (code) => {
        if (!started) {
          reject(new Error(`PostgreSQL exited with code ${code} before starting: ${startupOutput}`));
        }
        this.process = null;
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to spawn postgres: ${err.message}`));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!started) {
          reject(new Error(`PostgreSQL startup timed out after 30s. Output: ${startupOutput}`));
        }
      }, 30000);
    });
  }

  /**
   * Create a database if it doesn't exist
   * Uses a promise-based lock to prevent race conditions
   * @param {string} dbName - Database name to create
   */
  async createDatabase(dbName) {
    // Skip if already created this session
    if (this.createdDatabases.has(dbName)) {
      return;
    }

    // Skip 'postgres' database - it always exists
    if (dbName === 'postgres') {
      this.createdDatabases.add(dbName);
      return;
    }

    // Check if creation is already in progress for this database
    // If so, wait for it to complete
    if (this.creatingDatabases.has(dbName)) {
      await this.creatingDatabases.get(dbName);
      return;
    }

    // Create a promise that other concurrent requests will wait on
    let resolveCreation;
    const creationPromise = new Promise((resolve) => {
      resolveCreation = resolve;
    });
    this.creatingDatabases.set(dbName, creationPromise);

    try {
      // Use pg client to create database
      const { default: pg } = await import('pg');
      const client = new pg.Client({
        host: '127.0.0.1',
        port: this.port,
        user: this.user,
        password: this.password,
        database: 'postgres'
      });

      await client.connect();

      try {
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
        this.createdDatabases.add(dbName);
        this.logger.info({ dbName }, 'Database created');
      } catch (error) {
        // Database might already exist (from previous persistent session or race condition)
        // 42P04 = duplicate_database, 23505 = unique_violation
        if (error.code === '42P04' || error.code === '23505') {
          this.createdDatabases.add(dbName);
          this.logger.debug({ dbName }, 'Database already exists');
        } else {
          throw error;
        }
      } finally {
        await client.end();
      }
    } catch (error) {
      throw new Error(`Failed to create database '${dbName}': ${error.message}`);
    } finally {
      // Signal completion to waiting requests
      this.creatingDatabases.delete(dbName);
      resolveCreation();
    }
  }

  /**
   * Check if a database exists
   * @param {string} dbName - Database name to check
   */
  async databaseExists(dbName) {
    return this.createdDatabases.has(dbName);
  }

  /**
   * Stop the PostgreSQL instance
   */
  async stop() {
    if (this.process) {
      this.logger.info('Stopping PostgreSQL');

      return new Promise((resolve) => {
        this.process.on('close', () => {
          this.process = null;

          // Clean up temp directory in memory mode
          if (!this.persistent && this.databaseDir) {
            try {
              fs.rmSync(this.databaseDir, { recursive: true, force: true });
              this.logger.debug({ databaseDir: this.databaseDir }, 'Cleaned up temp directory');
            } catch (error) {
              this.logger.warn({ error: error.message }, 'Failed to clean up temp directory');
            }
          }

          resolve();
        });

        // Send SIGINT for graceful shutdown
        this.process.kill('SIGINT');

        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
        }, 5000);
      });
    }
  }

  /**
   * Get connection URL for a specific database
   * @param {string} dbName - Database name
   */
  getConnectionUrl(dbName = 'postgres') {
    return `postgresql://${this.user}:${this.password}@127.0.0.1:${this.port}/${dbName}`;
  }

  /**
   * Get manager stats
   */
  getStats() {
    return {
      port: this.port,
      databaseDir: this.databaseDir,
      persistent: this.persistent,
      databases: Array.from(this.createdDatabases)
    };
  }
}
