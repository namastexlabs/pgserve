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

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Ensure library symlinks exist in the lib directory.
 * The @embedded-postgres package ships versioned libraries but binaries look for soname versions.
 * This function scans for versioned libs and creates missing soname symlinks.
 *
 * Examples:
 * - Linux: libicuuc.so.60.2 -> libicuuc.so.60
 * - macOS: libicuuc.68.2.dylib -> libicuuc.68.dylib, libzstd.1.5.6.dylib -> libzstd.1.dylib
 *
 * @param {string} libDir - Path to the lib directory
 * @param {string} platform - Platform name ('linux' or 'darwin')
 */
function ensureLibrarySymlinks(libDir, platform) {
  try {
    const files = fs.readdirSync(libDir);

    if (platform === 'linux') {
      // Linux versioned libs: libname.so.X.Y -> libname.so.X
      // Pattern: libxxx.so.MAJOR.MINOR -> need libxxx.so.MAJOR
      for (const file of files) {
        const match = file.match(/^(lib.+\.so\.\d+)\.(\d+)$/);
        if (match) {
          const soname = match[1]; // e.g., libicuuc.so.60
          const sonameLink = path.join(libDir, soname);
          if (!fs.existsSync(sonameLink)) {
            try {
              fs.symlinkSync(file, sonameLink);
            } catch {
              // Non-fatal, might work with LD_LIBRARY_PATH anyway
            }
          }
        }
      }
    } else if (platform === 'darwin') {
      // macOS versioned libs have several patterns:
      // 1. libname.MAJOR.MINOR.dylib -> libname.MAJOR.dylib (ICU style)
      // 2. libname.MAJOR.MINOR.PATCH.dylib -> libname.MAJOR.dylib (zstd style)
      // 3. Also need libname.dylib -> libname.MAJOR.dylib for some libs
      for (const file of files) {
        // Match libxxx.MAJOR.MINOR.dylib or libxxx.MAJOR.MINOR.PATCH.dylib
        const match = file.match(/^(lib.+)\.(\d+)\.\d+(?:\.\d+)?\.dylib$/);
        if (match) {
          const basename = match[1]; // e.g., libicuuc or libzstd
          const major = match[2]; // e.g., 68 or 1

          // Create libname.MAJOR.dylib -> libname.MAJOR.MINOR.dylib
          const majorSoname = `${basename}.${major}.dylib`;
          const majorLink = path.join(libDir, majorSoname);
          if (!fs.existsSync(majorLink)) {
            try {
              fs.symlinkSync(file, majorLink);
            } catch {
              // Non-fatal
            }
          }

          // Create libname.dylib -> libname.MAJOR.dylib (base symlink)
          const baseSoname = `${basename}.dylib`;
          const baseLink = path.join(libDir, baseSoname);
          if (!fs.existsSync(baseLink)) {
            try {
              fs.symlinkSync(majorSoname, baseLink);
            } catch {
              // Non-fatal
            }
          }
        }
      }
    }
  } catch {
    // If we can't read the lib directory, continue anyway
    // The binary might still work if RPATH is set correctly
  }
}

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
    pkgName = '@embedded-postgres/windows-x64';
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Find the package in node_modules (check multiple locations for npx/pnpm/npm compatibility)
  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', pkgName, 'native', 'bin'),
    path.join(import.meta.dirname, '..', 'node_modules', pkgName, 'native', 'bin'),
    path.join(import.meta.dirname, '..', '..', pkgName, 'native', 'bin'), // Hoisted (npx flat structure)
    path.join(import.meta.dirname, '..', '..', '..', pkgName, 'native', 'bin'), // Extra level for some package managers
  ];

  for (const binDir of possiblePaths) {
    const initdb = path.join(binDir, platform === 'win32' ? 'initdb.exe' : 'initdb');
    const postgres = path.join(binDir, platform === 'win32' ? 'postgres.exe' : 'postgres');
    if (fs.existsSync(initdb) && fs.existsSync(postgres)) {
      // Resolve the actual binary paths (handles symlinks from package managers)
      const realInitdb = fs.realpathSync(initdb);
      const realPostgres = fs.realpathSync(postgres);
      const realBinDir = path.dirname(realInitdb);
      // lib directory is sibling to bin (contains bundled ICU libraries)
      const libDir = path.join(realBinDir, '..', 'lib');

      // Ensure library symlinks exist (Linux and macOS)
      // The package ships versioned libs (e.g., .60.2) but binaries look for sonames (e.g., .60)
      if ((platform === 'linux' || platform === 'darwin') && fs.existsSync(libDir)) {
        ensureLibrarySymlinks(libDir, platform);
      }

      return { initdb: realInitdb, postgres: realPostgres, binDir: realBinDir, libDir };
    }
  }

  throw new Error(`Could not find PostgreSQL binaries. Please run: npm install ${pkgName}`);
}

/**
 * Build environment variables for spawning PostgreSQL binaries.
 *
 * This is critical for cross-platform compatibility:
 * - The @embedded-postgres binaries are compiled against ICU 60
 * - Modern Linux distros (Ubuntu 22.04+, Debian 12+) ship ICU 70+
 * - The binaries have RUNPATH=$ORIGIN/../lib, but this fails when:
 *   - Package managers (pnpm, yarn) use symlinks/hardlinks differently
 *   - The lib/ directory isn't accessible relative to the binary's resolved path
 *
 * Solution: Explicitly set LD_LIBRARY_PATH to include the bundled libraries.
 *
 * @param {string} libDir - Path to the lib directory containing ICU libraries
 * @returns {NodeJS.ProcessEnv} Environment variables for spawn()
 */
function buildSpawnEnv(libDir) {
  const platform = os.platform();
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };

  if (platform === 'linux') {
    // Linux: LD_LIBRARY_PATH for runtime library loading
    // Prepend our lib dir to ensure our bundled ICU libs are found first
    const existingLdPath = process.env.LD_LIBRARY_PATH || '';
    env.LD_LIBRARY_PATH = libDir + (existingLdPath ? `:${existingLdPath}` : '');
  } else if (platform === 'darwin') {
    // macOS: DYLD_LIBRARY_PATH for runtime library loading
    // Note: macOS binaries typically use @rpath/@loader_path, but we set this for safety
    const existingDyldPath = process.env.DYLD_LIBRARY_PATH || '';
    env.DYLD_LIBRARY_PATH = libDir + (existingDyldPath ? `:${existingDyldPath}` : '');
  }
  // Windows doesn't need this - it uses PATH or side-by-side assemblies

  return env;
}

/**
 * Build command array with shell wrapper for reliable library path export.
 * This ensures LD_LIBRARY_PATH is properly inherited by the child process.
 *
 * @param {string[]} cmd - Command and arguments
 * @param {string} libDir - Path to lib directory
 * @returns {string[]} Command array (may be wrapped in shell)
 */
function buildCommand(cmd, libDir) {
  const platform = os.platform();

  if (platform === 'linux') {
    // Use shell to explicitly export LD_LIBRARY_PATH before running the command
    // This is more reliable than passing env to spawn on some systems
    const cmdStr = cmd.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
    return ['/bin/sh', '-c', `export LD_LIBRARY_PATH="${libDir}:$LD_LIBRARY_PATH" && exec ${cmdStr}`];
  }

  // On other platforms, return command as-is (env passing works fine)
  return cmd;
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
    this.socketDir = null; // Unix socket directory for faster local connections
    this.adminPool = null; // Connection pool for database admin operations
    this.useRam = options.useRam || false; // Use /dev/shm for true RAM storage (Linux only)
    this.isTrueRam = false; // Tracks if we're actually using RAM storage

    // Sync/Replication options (for async sync to real PostgreSQL)
    this.syncEnabled = options.syncEnabled || false;
    this.syncManager = null; // Will be set via setSyncManager()
  }

  /**
   * Set the SyncManager for async replication
   * Called after PostgresManager is created but before start()
   * @param {SyncManager} syncManager
   */
  setSyncManager(syncManager) {
    this.syncManager = syncManager;
    this.syncEnabled = !!syncManager;
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
      // Memory mode: use /dev/shm if --ram flag, otherwise /tmp
      let baseDir = os.tmpdir();
      this.isTrueRam = false;

      if (this.useRam) {
        const platform = os.platform();
        if (platform === 'linux') {
          const shmDir = '/dev/shm';
          try {
            fs.accessSync(shmDir, fs.constants.W_OK);
            baseDir = shmDir;
            this.isTrueRam = true;
          } catch {
            throw new Error('--ram requires /dev/shm which is not available or not writable. Run without --ram flag.');
          }
        } else {
          throw new Error(`--ram is only supported on Linux. Current platform: ${platform}`);
        }
      }

      this.databaseDir = path.join(baseDir, `pgserve-${process.pid}-${Date.now()}`);
      // Clean up if exists from a previous failed run
      if (fs.existsSync(this.databaseDir)) {
        fs.rmSync(this.databaseDir, { recursive: true, force: true });
      }
    }

    // Create Unix socket directory (Linux/macOS only, Windows uses TCP)
    if (os.platform() !== 'win32') {
      this.socketDir = path.join(os.tmpdir(), `pgserve-sock-${process.pid}-${Date.now()}`);
      if (!fs.existsSync(this.socketDir)) {
        fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
      }
    }

    this.logger.info({
      databaseDir: this.databaseDir,
      persistent: this.persistent,
      trueRam: this.isTrueRam,
      port: this.port
    }, this.isTrueRam ? 'PostgreSQL using RAM storage (/dev/shm)' : 'Starting embedded PostgreSQL');

    // Check if data directory is already initialized
    const pgVersionFile = path.join(this.databaseDir, 'PG_VERSION');
    if (!fs.existsSync(pgVersionFile)) {
      await this._runInitDb();
    } else {
      this.logger.debug({ databaseDir: this.databaseDir }, 'Using existing data directory');
    }

    // Start PostgreSQL server
    await this._startPostgres();

    // Initialize admin connection pool (for database creation operations)
    await this._initAdminPool();

    // For persistent mode, load existing databases into createdDatabases
    // This prevents "database already exists" errors when reusing data directories
    if (this.persistent) {
      await this._loadExistingDatabases();
    }

    this.logger.info({
      databaseDir: this.databaseDir,
      port: this.port,
      socketDir: this.socketDir,
      persistent: this.persistent
    }, 'PostgreSQL started successfully');

    return this;
  }

  /**
   * Run initdb to initialize the data directory
   * Uses Bun.spawn() for ~40% faster process startup
   */
  async _runInitDb() {
    // Create password file
    const randomId = crypto.randomBytes(6).toString('hex');
    const passwordFile = path.join(os.tmpdir(), `pg-password-${randomId}`);
    await Bun.write(passwordFile, this.password + '\n');
    await fs.promises.chmod(passwordFile, 0o600); // Secure file permissions

    this.logger.debug({ databaseDir: this.databaseDir }, 'Initializing PostgreSQL data directory');

    try {
      const initdbCmd = [
        this.binaries.initdb,
        `--pgdata=${this.databaseDir}`,
        '--auth=password',
        `--username=${this.user}`,
        `--pwfile=${passwordFile}`,
      ];
      const proc = Bun.spawn(buildCommand(initdbCmd, this.binaries.libDir), {
        env: buildSpawnEnv(this.binaries.libDir),
        stdout: 'pipe',
        stderr: 'pipe'
      });

      // Read stdout and stderr
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]);

      // Wait for process to complete
      const exitCode = await proc.exited;

      // Clean up password file
      try {
        await fs.promises.unlink(passwordFile);
      } catch {
        // Ignore cleanup errors
      }

      if (exitCode === 0) {
        this.logger.debug('initdb completed successfully');
      } else {
        this.logger.error({ code: exitCode, stdout, stderr }, 'initdb failed');
        throw new Error(`initdb failed with code ${exitCode}: ${stderr || stdout}`);
      }
    } catch (err) {
      // Clean up password file on error
      try {
        await fs.promises.unlink(passwordFile);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(`Failed to run initdb: ${err.message}`);
    }
  }

  /**
   * Initialize admin connection pool for database operations
   * Uses Bun.sql for 2x faster PostgreSQL queries
   */
  async _initAdminPool() {
    const { SQL } = await import('bun');

    // Bun.sql config - uses TCP connections (Unix sockets not directly supported)
    // This is fine for admin queries (low volume, local connection)
    this.adminPool = new SQL({
      hostname: '127.0.0.1',
      port: this.port,
      database: 'postgres',
      username: this.user,
      password: this.password,
      max: 5, // Small pool - only for CREATE DATABASE operations
      idleTimeout: 30,
      connectionTimeout: 5,
    });

    // Verify connection is working with a simple query
    await this.adminPool`SELECT 1`;

    this.logger.debug({
      host: '127.0.0.1',
      maxConnections: 5
    }, 'Admin connection pool initialized (Bun.sql)');
  }

  /**
   * Load existing databases into createdDatabases Set (for persistent mode)
   * This allows pgserve to reuse existing data directories without
   * attempting to CREATE DATABASE for databases that already exist.
   */
  async _loadExistingDatabases() {
    try {
      const result = await this.adminPool`
        SELECT datname FROM pg_database
        WHERE datistemplate = false
        AND datname NOT IN ('postgres', 'template0', 'template1')
      `;

      for (const row of result) {
        this.createdDatabases.add(row.datname);
      }

      this.logger.info({
        databases: Array.from(this.createdDatabases),
        count: this.createdDatabases.size
      }, 'Loaded existing databases from persistent storage');
    } catch (error) {
      // Non-fatal - if we can't load existing DBs, createDatabase will handle it
      this.logger.warn({ error: error.message }, 'Failed to load existing databases');
    }
  }

  /**
   * Start the PostgreSQL server process
   * Uses Bun.spawn() for ~40% faster process startup
   */
  async _startPostgres() {
    return new Promise((resolve, reject) => {
      // Build PostgreSQL arguments
      const pgArgs = [
        this.binaries.postgres,
        '-D', this.databaseDir,
        '-p', this.port.toString(),
      ];

      // Enable Unix socket for faster local connections (Linux/macOS)
      // Windows falls back to TCP only
      if (this.socketDir) {
        pgArgs.push('-k', this.socketDir);
      } else {
        pgArgs.push('-k', ''); // Disable Unix socket on Windows
      }

      // Add logical replication settings when sync is enabled
      // These settings enable PostgreSQL's native WAL-based replication
      // with ZERO hot path impact (handled by PostgreSQL's WAL writer process)
      if (this.syncEnabled) {
        pgArgs.push(
          '-c', 'wal_level=logical',           // Enable logical decoding
          '-c', 'max_replication_slots=10',    // Support multiple subscriptions
          '-c', 'max_wal_senders=10',          // Parallel replication streams
          '-c', 'wal_keep_size=512MB',         // Retain WAL for catchup
        );
        this.logger.info('Logical replication enabled for sync');
      }

      this.process = Bun.spawn(buildCommand(pgArgs, this.binaries.libDir), {
        env: buildSpawnEnv(this.binaries.libDir),
        stdout: 'pipe',
        stderr: 'pipe'
      });

      let started = false;
      let startupOutput = '';

      // Read stderr in streaming fashion to detect startup
      const readStream = async (stream) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const message = decoder.decode(value);
            startupOutput += message;
            this.logger.debug({ pgOutput: message.trim() }, 'PostgreSQL output');

            // Check for ready message
            if (!started && (message.includes('database system is ready to accept connections') ||
                message.includes('ready to accept connections'))) {
              started = true;
              resolve();
            }
          }
        } catch {
          // Stream closed
        }
      };

      // Start reading both streams
      readStream(this.process.stderr);
      readStream(this.process.stdout);

      // Handle process exit
      this.process.exited.then((code) => {
        if (!started) {
          reject(new Error(`PostgreSQL exited with code ${code} before starting: ${startupOutput}`));
        }
        this.process = null;
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

    // Use Bun.sql for faster database creation
    let createError = null;
    try {
      // Escape identifier manually (double quotes, escape internal quotes)
      const escapedName = `"${dbName.replace(/"/g, '""')}"`;
      await this.adminPool.unsafe(`CREATE DATABASE ${escapedName}`);
      this.createdDatabases.add(dbName);
      this.logger.info({ dbName }, 'Database created');

      // Trigger async sync setup (non-blocking, doesn't affect hot path)
      if (this.syncManager) {
        this.syncManager.setupDatabaseSync(dbName)
          .catch(err => this.logger.warn({ dbName, err: err.message }, 'Sync setup failed (non-fatal)'));
      }
    } catch (error) {
      // Database might already exist (from previous persistent session or race condition)
      // 42P04 = duplicate_database, 23505 = unique_violation
      // Also check error.message for Bun.sql compatibility (may not expose SQLSTATE codes)
      const isAlreadyExists = error.code === '42P04' ||
                              error.code === '23505' ||
                              error.message?.includes('already exists');
      if (isAlreadyExists) {
        this.createdDatabases.add(dbName);
        this.logger.debug({ dbName }, 'Database already exists');
      } else {
        createError = error;
      }
    } finally {
      // Signal completion to waiting requests
      this.creatingDatabases.delete(dbName);
      resolveCreation();
    }

    if (createError) {
      throw new Error(`Failed to create database '${dbName}': ${createError.message}`);
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
    // Close admin pool first (Bun.sql)
    if (this.adminPool) {
      await this.adminPool.close();
      this.adminPool = null;
    }

    if (this.process) {
      this.logger.info('Stopping PostgreSQL');

      // Send SIGINT for graceful shutdown
      this.process.kill('SIGINT');

      // Set up force kill after 5 seconds
      const forceKillTimeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);

      // Wait for process to exit (Bun.spawn uses exited promise)
      await this.process.exited;
      clearTimeout(forceKillTimeout);
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

      // Clean up socket directory
      if (this.socketDir) {
        try {
          fs.rmSync(this.socketDir, { recursive: true, force: true });
          this.logger.debug({ socketDir: this.socketDir }, 'Cleaned up socket directory');
        } catch (error) {
          this.logger.warn({ error: error.message }, 'Failed to clean up socket directory');
        }
      }
    }
  }

  /**
   * Get the Unix socket path for PostgreSQL connections
   * Returns null on Windows (use TCP instead)
   */
  getSocketPath() {
    if (!this.socketDir) return null;
    return path.join(this.socketDir, `.s.PGSQL.${this.port}`);
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
      socketDir: this.socketDir,
      socketPath: this.getSocketPath(),
      persistent: this.persistent,
      databases: Array.from(this.createdDatabases)
    };
  }
}
