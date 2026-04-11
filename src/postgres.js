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

/* global fetch, Bun */
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Get platform key for binary lookup (e.g., 'windows-x64', 'linux-x64', 'darwin-arm64')
 * @returns {string} Platform key
 */
function getPlatformKey() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32') return 'windows-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Get the directory where extracted binaries are cached
 * @returns {string} Cache directory path
 */
function getBinaryCacheDir() {
  const platformKey = getPlatformKey();
  return path.join(os.homedir(), '.pgserve', 'bin', platformKey);
}

/**
 * Download and extract PostgreSQL binaries on first run.
 * Downloads from npm registry (@embedded-postgres packages).
 *
 * @returns {Promise<string>} Path to extracted directory
 */
async function downloadPostgresBinaries() {
  const platform = os.platform();
  const cacheDir = getBinaryCacheDir();
  const cacheBinDir = path.join(cacheDir, 'bin');
  const initdbName = platform === 'win32' ? 'initdb.exe' : 'initdb';
  const postgresName = platform === 'win32' ? 'postgres.exe' : 'postgres';

  // Check if already downloaded
  if (fs.existsSync(path.join(cacheBinDir, initdbName)) &&
      fs.existsSync(path.join(cacheBinDir, postgresName))) {
    return cacheDir;
  }

  const platformKey = getPlatformKey();
  const pkgName = `@embedded-postgres/${platformKey}`;
  const pkgVersion = '18.2.0-beta.16';

  console.log(`[pgserve] PostgreSQL binaries not found.`);
  console.log(`[pgserve] Downloading ${pkgName}@${pkgVersion}...`);

  // Get tarball URL from npm registry
  const registryUrl = `https://registry.npmjs.org/${pkgName}`;
  const registryRes = await fetch(registryUrl);
  if (!registryRes.ok) {
    throw new Error(`Failed to fetch package info: ${registryRes.status}`);
  }
  const pkgInfo = await registryRes.json();
  const tarballUrl = pkgInfo.versions[pkgVersion]?.dist?.tarball;

  if (!tarballUrl) {
    throw new Error(`Version ${pkgVersion} not found for ${pkgName}`);
  }

  // Download tarball
  console.log(`[pgserve] Downloading from npm registry...`);
  const tarballRes = await fetch(tarballUrl);
  if (!tarballRes.ok) {
    throw new Error(`Failed to download tarball: ${tarballRes.status}`);
  }

  const tarballBuffer = await tarballRes.arrayBuffer();
  const tarballSize = (tarballBuffer.byteLength / 1024 / 1024).toFixed(1);
  console.log(`[pgserve] Downloaded ${tarballSize} MB`);

  // Create temp file for tarball
  const tempDir = path.join(os.tmpdir(), `pgserve-download-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const tarballPath = path.join(tempDir, 'package.tgz');
  fs.writeFileSync(tarballPath, Buffer.from(tarballBuffer));

  // Extract tarball using tar (available on all platforms via bun/node)
  console.log(`[pgserve] Extracting binaries...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  // Use Bun.spawn for extraction
  const extractProc = Bun.spawn(['tar', '-xzf', tarballPath, '-C', tempDir], {
    stdout: 'pipe',
    stderr: 'pipe'
  });
  await extractProc.exited;

  // Copy native/* to cache dir
  const nativeDir = path.join(tempDir, 'package', 'native');
  if (!fs.existsSync(nativeDir)) {
    throw new Error('Extracted package does not contain native/ directory');
  }

  // Copy files recursively
  await copyDirRecursive(nativeDir, cacheDir);

  // Make executables executable (Unix only)
  if (platform !== 'win32') {
    const binDir = path.join(cacheDir, 'bin');
    if (fs.existsSync(binDir)) {
      const files = fs.readdirSync(binDir);
      for (const file of files) {
        const filePath = path.join(binDir, file);
        try {
          fs.chmodSync(filePath, 0o755);
        } catch {
          // Ignore
        }
      }
    }
  }

  // Cleanup temp
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  console.log(`[pgserve] PostgreSQL binaries installed to ${cacheDir}`);
  return cacheDir;
}

/**
 * Recursively copy a directory
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 */
async function copyDirRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      await copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

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
// Now async to support bundled binary extraction
async function getBinaryPaths() {
  const platform = os.platform();
  const arch = os.arch();
  const exeSuffix = platform === 'win32' ? '.exe' : '';

  // Priority 1: Check extracted cache directory (standalone exe mode)
  // This is where bundled binaries are extracted on first run
  const cacheDir = getBinaryCacheDir();
  const cacheBinDir = path.join(cacheDir, 'bin');
  const cachedInitdb = path.join(cacheBinDir, 'initdb' + exeSuffix);
  const cachedPostgres = path.join(cacheBinDir, 'postgres' + exeSuffix);

  if (fs.existsSync(cachedInitdb) && fs.existsSync(cachedPostgres)) {
    const libDir = path.join(cacheDir, 'lib');
    if ((platform === 'linux' || platform === 'darwin') && fs.existsSync(libDir)) {
      ensureLibrarySymlinks(libDir, platform);
    }
    return { initdb: cachedInitdb, postgres: cachedPostgres, binDir: cacheBinDir, libDir };
  }

  // Priority 2: Download binaries if not found (standalone exe mode)
  // This downloads from npm registry on first run
  const downloadedDir = await downloadPostgresBinaries();
  if (downloadedDir) {
    const downloadedBinDir = path.join(downloadedDir, 'bin');
    const downloadedInitdb = path.join(downloadedBinDir, 'initdb' + exeSuffix);
    const downloadedPostgres = path.join(downloadedBinDir, 'postgres' + exeSuffix);

    if (fs.existsSync(downloadedInitdb) && fs.existsSync(downloadedPostgres)) {
      const libDir = path.join(downloadedDir, 'lib');
      if ((platform === 'linux' || platform === 'darwin') && fs.existsSync(libDir)) {
        ensureLibrarySymlinks(libDir, platform);
      }
      return { initdb: downloadedInitdb, postgres: downloadedPostgres, binDir: downloadedBinDir, libDir };
    }
  }

  // Priority 3: Find the package in node_modules (npm install case)
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

  const possiblePaths = [
    path.join(process.cwd(), 'node_modules', pkgName, 'native', 'bin'),
    path.join(import.meta.dirname, '..', 'node_modules', pkgName, 'native', 'bin'),
    path.join(import.meta.dirname, '..', '..', pkgName, 'native', 'bin'), // Hoisted (npx flat structure)
    path.join(import.meta.dirname, '..', '..', '..', pkgName, 'native', 'bin'), // Extra level for some package managers
  ];

  for (const binDir of possiblePaths) {
    const initdb = path.join(binDir, 'initdb' + exeSuffix);
    const postgres = path.join(binDir, 'postgres' + exeSuffix);
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

/**
 * Compare a persisted pgvector install metadata record against the currently
 * detected PG major and postgres binary path. Returns `true` only when the
 * metadata is a plain object, has the expected shape, and matches the
 * runtime environment. Used by the pgvector auto-heal path to decide whether
 * an already-present `vector.so` is safe to reuse or must be replaced.
 *
 * Exported for unit tests — keep this pure (no I/O, no `this`).
 *
 * @param {unknown} meta - Value parsed from `vector.meta.json`, or null.
 * @param {{pgMajor: string, postgresPath: string}} runtime - Current env.
 * @returns {boolean}
 */
export function pgvectorMetaMatches(meta, runtime) {
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.pgMajor !== 'string' || meta.pgMajor !== runtime.pgMajor) return false;
  // postgresPath is optional in older metadata — only compare when present.
  if (meta.postgresPath && meta.postgresPath !== runtime.postgresPath) return false;
  return true;
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

    // pgvector extension auto-enable
    this.enablePgvector = options.enablePgvector || false;
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
    // Get binary paths (may extract bundled binaries on first run)
    this.binaries = await getBinaryPaths();

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

    // Pre-install pgvector extension files if enabled
    // This ensures vector.so + vector.control are ready before any CREATE EXTENSION call
    if (this.enablePgvector) {
      await this.ensurePgvectorFiles();
    }

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
    const isWindows = process.platform === 'win32';

    // Bun.sql config - uses TCP connections (Unix sockets not directly supported)
    // This is fine for admin queries (low volume, local connection)
    // Windows needs longer timeout due to higher network stack latency
    this.adminPool = new SQL({
      hostname: '127.0.0.1',
      port: this.port,
      database: 'postgres',
      username: this.user,
      password: this.password,
      max: 5, // Small pool - only for CREATE DATABASE operations
      idleTimeout: 30,
      connectionTimeout: isWindows ? 15 : 5,
    });

    // Verify connection with retry logic
    // TCP port being open doesn't mean PostgreSQL protocol is ready
    // This handles the race condition on Windows where the port binds
    // before the server is fully ready to accept protocol handshakes
    const maxRetries = isWindows ? 10 : 5;  // More retries on Windows
    const baseDelay = isWindows ? 2000 : 1000; // Longer delay on Windows

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.adminPool`SELECT 1`;
        this.logger.debug({
          host: '127.0.0.1',
          maxConnections: 5,
          attempt
        }, 'Admin connection pool initialized (Bun.sql)');
        return; // Success
      } catch (err) {
        if (attempt === maxRetries) {
          throw new Error(`Failed to initialize admin pool after ${maxRetries} attempts: ${err.message}`);
        }
        this.logger.debug({
          attempt,
          maxRetries,
          error: err.message
        }, 'Admin pool connection failed, retrying...');
        // Exponential backoff: 1s, 2s, 3s, 4s
        await new Promise(resolve => setTimeout(resolve, baseDelay * attempt));
      }
    }
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
        '-c', 'max_connections=1000',  // Support high connection counts for stress testing
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
      let processExited = false;
      let portBindingSeen = false;
      const portStr = this.port.toString();

      // Hybrid startup detection:
      // 1. TCP connection polling (works on Linux/macOS)
      // 2. Log-based detection (fallback for Windows where Bun.connect may fail)
      // Whichever succeeds first wins

      const markReady = (method) => {
        if (!started) {
          started = true;
          this.logger.info({ port: this.port, method }, 'PostgreSQL ready');
          resolve();
        }
      };

      // Read stderr - detect port binding in logs (locale-independent: just look for port number)
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

            // Detect port binding - look for our port number in log output
            // This is locale-independent (numbers are universal)
            if (!portBindingSeen && message.includes(portStr)) {
              portBindingSeen = true;
              // Give PostgreSQL 500ms after port binding to finish startup
              setTimeout(() => {
                if (!started && !processExited) {
                  markReady('log-port-binding');
                }
              }, 500);
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
        processExited = true;
        if (!started) {
          reject(new Error(`PostgreSQL exited with code ${code} before starting: ${startupOutput}`));
        }
        this.process = null;
      });

      // Method 1: TCP connection polling (preferred, works on Linux/macOS)
      const tryConnect = () => {
        return new Promise((resolveConn, rejectConn) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              rejectConn(new Error('Connection timeout'));
            }
          }, 500);

          Bun.connect({
            hostname: '127.0.0.1',
            port: this.port,
            socket: {
              open(socket) {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  socket.end();
                  resolveConn(true);
                }
              },
              connectError(_socket, error) {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  rejectConn(error);
                }
              },
              error(_socket, error) {
                if (!resolved) {
                  resolved = true;
                  clearTimeout(timeout);
                  rejectConn(error);
                }
              },
              data() {},
              close() {},
            },
          }).catch((err) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              rejectConn(err);
            }
          });
        });
      };

      const pollConnection = async () => {
        const startTime = Date.now();
        const timeoutMs = 30000;
        const isWindows = process.platform === 'win32';

        while (Date.now() - startTime < timeoutMs && !started) {
          if (processExited) return;

          try {
            await tryConnect();
            // On Windows, TCP port opens before PostgreSQL is fully ready for protocol handshakes
            // Add delay to let PostgreSQL complete its startup sequence
            if (isWindows) {
              await Bun.sleep(2000); // 2 second delay for Windows
            }
            markReady('tcp');
            return;
          } catch {
            await Bun.sleep(200);
          }
        }
      };

      // Start TCP polling (log detection is handled inline above via setTimeout)
      pollConnection();

      // Overall timeout with helpful error for Windows firewall
      setTimeout(() => {
        if (!started && !processExited) {
          const isWindows = process.platform === 'win32';
          const hint = isWindows
            ? '\n\nOn Windows, this may be caused by Windows Firewall blocking localhost connections.\nTry: netsh advfirewall firewall add rule name="pgserve" dir=in action=allow protocol=TCP localport=' + this.port
            : '';
          reject(new Error(`PostgreSQL startup timed out after 30s.${hint}\n\nOutput: ${startupOutput}`));
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

      // Auto-enable pgvector extension if configured
      if (this.enablePgvector) {
        await this.enablePgvectorExtension(dbName);
      }

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
   * Ensure pgvector extension files are installed in the PG binary dirs.
   * Downloads prebuilt vector.so from apt.postgresql.org on first use (cached).
   * Patches vector.control to use absolute module_pathname.
   *
   * Linux only — .deb extraction requires dpkg-deb or ar+tar.
   * Serialized via _pgvectorInstallPromise to prevent concurrent races.
   */
  async ensurePgvectorFiles() {
    // Serialize: only one install runs at a time
    if (this._pgvectorInstallPromise) {
      return this._pgvectorInstallPromise;
    }
    this._pgvectorInstallPromise = this._doEnsurePgvectorFiles();
    try {
      await this._pgvectorInstallPromise;
    } finally {
      this._pgvectorInstallPromise = null;
    }
  }

  async _doEnsurePgvectorFiles() {
    if (!this.binaries?.libDir) return;

    // Linux only — .deb packages are Linux-specific
    if (os.platform() !== 'linux') {
      this.logger.info('pgvector auto-install is Linux-only. On macOS, install via: brew install pgvector');
      return;
    }

    const paths = this._pgvectorPaths();

    let pgMajor;
    try {
      pgMajor = await this._detectPgMajor();
    } catch (error) {
      this.logger.warn({ err: error.message }, 'Failed to detect PG major version for pgvector install (non-fatal)');
      return;
    }

    // Proactive staleness check: if vector.so and vector.control both exist,
    // trust them ONLY if the sidecar metadata file matches the current PG
    // major and the current postgres binary path. Any mismatch — including a
    // missing metadata file from a pre-auto-heal install — triggers a clean
    // reinstall. This is what heals existing deployments that were shipped
    // with the regex bug: on first run after upgrading pgserve, the stale
    // PG17 .so will be detected (no metadata → mismatch) and replaced.
    const filesPresent = fs.existsSync(paths.vectorSo) && fs.existsSync(paths.vectorControl);
    if (filesPresent) {
      const meta = this._readPgvectorMeta(paths.vectorMeta);
      if (pgvectorMetaMatches(meta, { pgMajor, postgresPath: this.binaries.postgres })) {
        return;
      }
      this.logger.warn(
        {
          detectedPgMajor: pgMajor,
          metaPgMajor: meta?.pgMajor ?? null,
          metaPresent: meta !== null,
          vectorMeta: paths.vectorMeta,
        },
        'pgvector install metadata missing or mismatched — auto-healing stale install'
      );
      this._removePgvectorFiles(paths);
    } else {
      this.logger.info('pgvector extension files not found — downloading prebuilt binary...');
    }

    try {
      await this._installPgvectorFromDeb({ pgMajor, ...paths });
    } catch (error) {
      this.logger.warn({ err: error.message }, 'Failed to install pgvector extension files (non-fatal)');
    }
  }

  /**
   * Compute the canonical pgvector file paths for this PG install.
   * Extracted so proactive install, reactive heal, and cleanup all agree.
   */
  _pgvectorPaths() {
    const libDir = this.binaries.libDir;
    const binDir = this.binaries.binDir;
    const extDir = path.join(path.dirname(binDir), 'share', 'postgresql', 'extension');
    return {
      libDir,
      extDir,
      vectorSo: path.join(libDir, 'vector.so'),
      vectorControl: path.join(extDir, 'vector.control'),
      vectorMeta: path.join(libDir, 'vector.meta.json'),
    };
  }

  /**
   * Parse `postgres --version` output and return the major version string.
   * Throws on unparseable output so callers can fail loudly instead of
   * silently downloading the wrong pgvector .deb.
   */
  async _detectPgMajor() {
    // `postgres --version` output is `postgres (PostgreSQL) 18.2`, so the
    // regex must tolerate the `)` that separates the product name from the
    // version number. The previous pattern `/PostgreSQL (\d+)/` expected a
    // digit immediately after `PostgreSQL ` and silently fell back to '17'
    // on PG 14+, causing the wrong pgvector .deb to be downloaded and a
    // later "incompatible library version mismatch" at CREATE EXTENSION time.
    const { execSync } = await import('node:child_process');
    const pgVersion = execSync(`${this.binaries.postgres} --version`, { encoding: 'utf-8' }).trim();
    const majorMatch = pgVersion.match(/PostgreSQL\)?\s+(\d+)/);
    if (!majorMatch) {
      throw new Error(`Could not detect PostgreSQL major version from: ${JSON.stringify(pgVersion)}`);
    }
    this.logger.debug({ pgMajor: majorMatch[1], pgVersion }, 'Detected PostgreSQL major version');
    return majorMatch[1];
  }

  /**
   * Read and parse the pgvector install metadata sidecar, if present.
   * Returns null on missing file or any parse error (caller treats both as
   * "unknown, needs reinstall").
   */
  _readPgvectorMeta(metaPath) {
    try {
      if (!fs.existsSync(metaPath)) return null;
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Write the pgvector install metadata sidecar. Best-effort — failure to
   * write metadata should not crash the install; it just means the next
   * startup will trigger a re-heal (idempotent).
   */
  _writePgvectorMeta(metaPath, data) {
    try {
      fs.writeFileSync(metaPath, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.warn({ err: error.message, metaPath }, 'Failed to write pgvector metadata sidecar');
    }
  }

  /**
   * Remove all pgvector files (vector.so, vector.meta.json, and any
   * vector*.sql / vector.control files in the extension dir) so that a
   * subsequent install starts from a clean slate. Used by the auto-heal
   * paths — never call this while PG is mid-transaction.
   */
  _removePgvectorFiles(paths) {
    const { libDir, extDir, vectorSo, vectorMeta } = paths;
    const toRemove = [vectorSo, vectorMeta];
    if (fs.existsSync(extDir)) {
      for (const f of fs.readdirSync(extDir)) {
        if (f.startsWith('vector')) toRemove.push(path.join(extDir, f));
      }
    }
    for (const p of toRemove) {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
    this.logger.info({ libDir, extDir }, 'Removed stale pgvector files');
  }

  /**
   * Download + extract + install pgvector from apt.postgresql.org for the
   * given PG major. Writes a metadata sidecar on success so future starts
   * can detect staleness without re-downloading.
   */
  async _installPgvectorFromDeb({ pgMajor, extDir, vectorSo, vectorControl, vectorMeta }) {
    const { execSync } = await import('node:child_process');

    // Detect architecture — fail explicitly on unsupported platforms
    const nodeArch = os.arch();
    let arch;
    if (nodeArch === 'x64') arch = 'amd64';
    else if (nodeArch === 'arm64') arch = 'arm64';
    else {
      this.logger.warn({ arch: nodeArch }, 'Unsupported architecture for pgvector auto-install. Supported: x64, arm64');
      return;
    }

    // Download prebuilt pgvector .deb from apt.postgresql.org (HTTPS)
    // Version 0.8.1-2 — update when new releases ship
    const pgvectorVersion = '0.8.1-2';
    const debUrl = `https://apt.postgresql.org/pub/repos/apt/pool/main/p/pgvector/postgresql-${pgMajor}-pgvector_${pgvectorVersion}.pgdg%2B1_${arch}.deb`;
    this.logger.info({ url: debUrl, pgMajor }, 'Downloading pgvector...');

    const res = await fetch(debUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());

    // Extract .deb (it's an ar archive containing data.tar.xz)
    const tmpDir = path.join(os.tmpdir(), `pgserve-pgvector-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const debPath = path.join(tmpDir, 'pgvector.deb');
    fs.writeFileSync(debPath, buffer);

    try {
      // Use dpkg-deb or ar to extract
      try {
        execSync(`dpkg-deb -x ${debPath} ${tmpDir}/extracted`, { stdio: 'pipe' });
      } catch {
        // Fallback: try ar + tar
        fs.mkdirSync(path.join(tmpDir, 'extracted'), { recursive: true });
        execSync(`cd ${tmpDir} && ar x pgvector.deb && tar xf data.tar.* -C ${tmpDir}/extracted 2>/dev/null || tar xf data.tar.xz -C ${tmpDir}/extracted`, { stdio: 'pipe' });
      }

      // Copy .so file — fail loudly if missing so we don't silently ship broken
      const soSrc = path.join(tmpDir, 'extracted', 'usr', 'lib', 'postgresql', pgMajor, 'lib', 'vector.so');
      if (!fs.existsSync(soSrc)) {
        throw new Error(`Extracted .deb missing expected vector.so at ${soSrc}`);
      }
      fs.copyFileSync(soSrc, vectorSo);
      this.logger.info({ path: vectorSo }, 'Installed vector.so');

      // Copy extension SQL + control files
      const extSrc = path.join(tmpDir, 'extracted', 'usr', 'share', 'postgresql', pgMajor, 'extension');
      if (fs.existsSync(extSrc)) {
        fs.mkdirSync(extDir, { recursive: true });
        for (const f of fs.readdirSync(extSrc)) {
          if (f.startsWith('vector')) {
            fs.copyFileSync(path.join(extSrc, f), path.join(extDir, f));
          }
        }
        this.logger.info({ path: extDir }, 'Installed vector extension SQL files');
      }

      // Patch vector.control to use absolute module_pathname
      // (embedded PG's $libdir doesn't match the compiled-in path)
      if (fs.existsSync(vectorControl)) {
        let control = fs.readFileSync(vectorControl, 'utf-8');
        control = control.replace(
          /module_pathname\s*=\s*'\$libdir\/vector'/,
          `module_pathname = '${vectorSo.replace('.so', '')}'`
        );
        fs.writeFileSync(vectorControl, control);
        this.logger.info('Patched vector.control with absolute module path');
      }

      // Write metadata sidecar so future starts can detect staleness
      this._writePgvectorMeta(vectorMeta, {
        pgMajor,
        pgvectorVersion,
        sourceUrl: debUrl,
        postgresPath: this.binaries.postgres,
        installedAt: new Date().toISOString(),
      });

      this.logger.info({ pgMajor, pgvectorVersion }, 'pgvector extension installed successfully');
    } finally {
      // Always clean up tmpdir, even on failure
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Tear down an existing pgvector install and reinstall from scratch.
   * Called reactively when CREATE EXTENSION surfaces an ABI mismatch —
   * this is the last-resort heal for deployments that somehow bypassed
   * the proactive staleness check (e.g. metadata file got corrupted, or
   * the files were placed by an older pgserve that didn't write metadata).
   */
  async _healStalePgvector() {
    if (!this.binaries?.libDir || os.platform() !== 'linux') return;
    const paths = this._pgvectorPaths();
    this._removePgvectorFiles(paths);
    // _doEnsurePgvectorFiles is serialized via _pgvectorInstallPromise;
    // this call goes through the mutex wrapper to stay race-safe.
    await this.ensurePgvectorFiles();
  }

  /**
   * Enable pgvector extension on a database
   * Creates a temporary connection to the specific database to run CREATE EXTENSION.
   * If the CREATE hits an ABI mismatch (stale vector.so from an older pgserve
   * install that shipped the wrong PG major), auto-heal the install and retry
   * once. This is the reactive safety net for deployments that already have a
   * broken vector.so on disk when this version of pgserve first starts.
   * @param {string} dbName - Database name to enable pgvector on
   */
  async enablePgvectorExtension(dbName) {
    // Ensure extension files are installed first (proactive path)
    await this.ensurePgvectorFiles();

    const { SQL } = await import('bun');

    const tryCreateExtension = async () => {
      const dbPool = new SQL({
        hostname: '127.0.0.1',
        port: this.port,
        database: dbName,
        username: this.user,
        password: this.password,
        max: 1,
        idleTimeout: 5,
        connectionTimeout: 5,
      });
      try {
        await dbPool.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
      } finally {
        await dbPool.close().catch(() => {});
      }
    };

    try {
      await tryCreateExtension();
      this.logger.info({ dbName }, 'pgvector extension enabled');
      return;
    } catch (error) {
      const msg = error?.message || '';
      // Postgres surfaces stale .so as "incompatible library version" or
      // "version mismatch" depending on the nature of the ABI break.
      // PG_MODULE_MAGIC mismatches show the same symptoms.
      const abiMismatch = /version mismatch|incompatible library version|PG_MODULE_MAGIC/i.test(msg);
      if (!abiMismatch) {
        this.logger.warn({ dbName, err: msg }, 'Failed to enable pgvector extension (non-fatal)');
        return;
      }

      this.logger.warn(
        { dbName, err: msg },
        'pgvector ABI mismatch detected — auto-healing stale install and retrying'
      );
      try {
        await this._healStalePgvector();
      } catch (healError) {
        this.logger.error({ dbName, err: healError.message }, 'pgvector auto-heal failed during reinstall');
        return;
      }

      try {
        await tryCreateExtension();
        this.logger.info({ dbName }, 'pgvector auto-heal successful — extension enabled');
      } catch (retryError) {
        this.logger.error(
          { dbName, err: retryError.message },
          'pgvector still failing after auto-heal — manual intervention required'
        );
      }
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
