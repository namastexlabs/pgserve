/**
 * pgserve daemon — singleton control-socket server.
 *
 * One process per host. Listens on a well-known Unix socket
 * (`$XDG_RUNTIME_DIR/pgserve/control.sock`, fallback `/tmp/pgserve/control.sock`),
 * supervises a single PostgresManager instance, and proxies every accepted
 * client through to the underlying PG Unix socket.
 *
 * Singleton enforcement uses a PID lock file (`pgserve.pid`) co-located with
 * the control socket. A second daemon invocation refuses with the live PID;
 * a stale lock (process gone) is cleaned up automatically on next boot.
 *
 * Wave-2 scope (this file): transport layer + fingerprint accept hook.
 *   - Group 3: every accept derives a kernel-rooted peer fingerprint and
 *     audits a `connection_routed` event.
 *   - Group 4 will rewrite the startup-message database parameter.
 *   - Group 5 will install GC sweep triggers on the daemon.
 *   - Group 6 will add the optional `--listen` TCP bind.
 *
 * PR #24 invariants preserved:
 *   - `PostgresManager.start()` re-entry guard untouched.
 *   - `PostgresManager.stop()` nulls socketDir/databaseDir.
 *   - On abnormal daemon exit, the next boot's stale-pid cleanup unlinks
 *     the orphaned control socket *and* PID lock so we never leak either.
 */

/* global Bun */
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PostgresManager } from './postgres.js';
import { extractDatabaseName } from './protocol.js';
import { createLogger } from './logger.js';
import { handleControlAccept, initFingerprintFfi } from './fingerprint.js';
import { configureAudit } from './audit.js';

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
const GSSAPI_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

const MAX_STARTUP_BUFFER_SIZE = 1024 * 1024; // 1 MiB — same bound as router.js

/**
 * Resolve the directory that holds the daemon's control socket and pid lock.
 * `$XDG_RUNTIME_DIR/pgserve` when XDG is set (the systemd / freedesktop
 * convention), otherwise `/tmp/pgserve` as the documented fallback.
 */
export function resolveControlSocketDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : '/tmp';
  return path.join(base, 'pgserve');
}

export function resolveControlSocketPath(dir = resolveControlSocketDir()) {
  return path.join(dir, 'control.sock');
}

export function resolvePidLockPath(dir = resolveControlSocketDir()) {
  return path.join(dir, 'pgserve.pid');
}

/**
 * libpq compat path. When users say `psql -h $XDG_RUNTIME_DIR/pgserve`,
 * libpq looks for `<host>/.s.PGSQL.<port>` with port defaulting to 5432.
 * The daemon binds `control.sock` (per wish §Group 2) and ALSO publishes
 * a `.s.PGSQL.<port>` symlink to it so off-the-shelf clients connect.
 */
export function resolveLibpqCompatPath(dir = resolveControlSocketDir(), port = 5432) {
  return path.join(dir, `.s.PGSQL.${port}`);
}

/**
 * Return true if a process with the given pid is alive (signal 0 trick).
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we don't own it — still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Acquire the singleton PID lock, taking care of stale lock cleanup.
 *
 * Returns `{ acquired: true }` on success. On an already-running peer,
 * returns `{ acquired: false, pid }` so the caller can render a clean
 * "already running, pid N" error and exit non-zero.
 *
 * Cleanup contract on failed acquisition is the caller's responsibility:
 * we never unlink the socket of a *live* peer.
 *
 * @param {object} opts
 * @param {string} opts.pidLockPath
 * @param {string} opts.socketPath
 * @param {object} [opts.logger]
 */
export function acquirePidLock({ pidLockPath, socketPath, libpqCompatPath, logger }) {
  ensureDir(path.dirname(pidLockPath));

  const orphanPaths = [socketPath, libpqCompatPath].filter(Boolean);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(pidLockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // PID file exists. Read it and decide whether the owner is alive.
      let stalePid = null;
      try {
        const raw = fs.readFileSync(pidLockPath, 'utf8').trim();
        stalePid = parseInt(raw, 10);
      } catch {
        // Unreadable file is treated as stale.
      }

      if (Number.isInteger(stalePid) && isProcessAlive(stalePid)) {
        return { acquired: false, pid: stalePid };
      }

      // Stale lock — clean it up alongside any orphaned socket / symlink,
      // then retry. The next attempt either succeeds or surfaces a real
      // error.
      logger?.warn?.(
        { pidLockPath, stalePid },
        'Found stale daemon PID lock, cleaning up before retry',
      );
      try {
        fs.unlinkSync(pidLockPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      for (const p of orphanPaths) {
        try {
          fs.unlinkSync(p);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
      // Loop and retry the open-exclusive.
    }
  }
  // If we got here both attempts failed without throwing — should not happen.
  throw new Error('acquirePidLock: failed after stale-lock cleanup');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Send a SIGTERM to the daemon owning the lock. Returns the previous pid
 * if a daemon was found, or `null` if no live daemon exists.
 *
 * Used by `pgserve daemon stop`.
 */
export function stopDaemon({ controlSocketDir = resolveControlSocketDir(), timeoutMs = 5000 } = {}) {
  const pidLockPath = resolvePidLockPath(controlSocketDir);
  let pid = null;
  try {
    const raw = fs.readFileSync(pidLockPath, 'utf8').trim();
    pid = parseInt(raw, 10);
  } catch {
    return { stopped: false, reason: 'no-pid-file' };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    try { fs.unlinkSync(pidLockPath); } catch { /* swallow */ }
    return { stopped: false, reason: 'invalid-pid-file' };
  }

  if (!isProcessAlive(pid)) {
    try { fs.unlinkSync(pidLockPath); } catch { /* swallow */ }
    try { fs.unlinkSync(resolveControlSocketPath(controlSocketDir)); } catch { /* swallow */ }
    try { fs.unlinkSync(resolveLibpqCompatPath(controlSocketDir)); } catch { /* swallow */ }
    return { stopped: false, reason: 'stale-pid', pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, reason: 'signal-failed', pid, error: err.message };
  }

  // Wait for the daemon to remove its pid file.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(pidLockPath)) {
      return { stopped: true, pid };
    }
    Bun.sleepSync ? Bun.sleepSync(50) : sleepBlocking(50);
  }
  return { stopped: false, reason: 'timeout', pid };
}

function sleepBlocking(ms) {
  // Tiny blocking sleep used only by the CLI stop path. We avoid pulling in
  // an async dep here; ten 50ms ticks across the 5s timeout is fine.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * The daemon. Owns one PostgresManager and one Bun.listen({unix}) server.
 */
export class PgserveDaemon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.controlSocketDir = options.controlSocketDir || resolveControlSocketDir();
    this.controlSocketPath = options.controlSocketPath || resolveControlSocketPath(this.controlSocketDir);
    this.pidLockPath = options.pidLockPath || resolvePidLockPath(this.controlSocketDir);
    this.libpqPort = options.libpqPort || 5432;
    this.libpqCompatPath = options.libpqCompatPath || resolveLibpqCompatPath(this.controlSocketDir, this.libpqPort);
    this.maxConnections = options.maxConnections || 1000;
    this.autoProvision = options.autoProvision !== false;
    this.baseDir = options.baseDir || null;
    this.useRam = options.useRam || false;
    this.auditLogFile = options.auditLogFile || null;
    this.auditTarget = options.auditTarget || null;
    this.logger = options.logger || createLogger({ level: options.logLevel || 'info' });

    this.pgManager = options.pgManager || new PostgresManager({
      dataDir: this.baseDir,
      port: options.pgPort || 5433,
      logger: this.logger.child ? this.logger.child({ component: 'postgres' }) : this.logger,
      useRam: this.useRam,
      enablePgvector: options.enablePgvector || false,
    });

    this.server = null;
    this.connections = new Set();
    this.socketState = new WeakMap();
    this._lockAcquired = false;
    this._signalHandlersInstalled = false;
    this._stopping = false;

    this.setMaxListeners(this.maxConnections + 10);
  }

  /**
   * Start the daemon: acquire singleton lock, boot PG, bind control socket.
   *
   * Throws `DaemonAlreadyRunningError` (a tagged Error) when another live
   * pgserve daemon already owns the lock, so the CLI can render the
   * "already running, pid N" message and `exit(1)` cleanly.
   */
  async start() {
    if (this.server) {
      this.logger.warn?.({ pid: process.pid }, 'PgserveDaemon.start called while already running');
      return this;
    }

    ensureDir(this.controlSocketDir);

    const lock = acquirePidLock({
      pidLockPath: this.pidLockPath,
      socketPath: this.controlSocketPath,
      libpqCompatPath: this.libpqCompatPath,
      logger: this.logger,
    });
    if (!lock.acquired) {
      const err = new Error(`pgserve daemon already running, pid ${lock.pid}`);
      err.code = 'EALREADYRUNNING';
      err.pid = lock.pid;
      throw err;
    }
    this._lockAcquired = true;

    // Best-effort: tighten directory perms in case the dir pre-existed
    // from a previous user (e.g. /tmp/pgserve world-writable parent).
    try { fs.chmodSync(this.controlSocketDir, 0o700); } catch { /* swallow */ }

    // Wire up audit-log destination + fingerprint FFI before any accept
    // can fire, so handleSocketOpen always sees a primed environment.
    if (this.auditLogFile || this.auditTarget) {
      configureAudit({
        ...(this.auditLogFile ? { logFile: this.auditLogFile } : {}),
        ...(this.auditTarget ? { target: this.auditTarget } : {}),
      });
    }
    try {
      await initFingerprintFfi();
    } catch (err) {
      this.releaseLock();
      throw err;
    }

    this.installSignalHandlers();

    try {
      await this.pgManager.start();
    } catch (err) {
      // Release the lock before propagating — otherwise the operator has to
      // manually unlink a pid file that points at a dead process.
      this.releaseLock();
      throw err;
    }

    // Bind the control socket. Bun's listener writes to the path; we already
    // unlinked any stale socket in acquirePidLock (or no socket existed).
    const daemon = this;
    try {
      this.server = Bun.listen({
        unix: this.controlSocketPath,
        socket: {
          data(socket, data) {
            daemon.handleSocketData(socket, data);
          },
          open(socket) {
            daemon.handleSocketOpen(socket);
          },
          close(socket) {
            daemon.handleSocketClose(socket);
          },
          error(socket, error) {
            daemon.handleSocketError(socket, error);
          },
          drain(socket) {
            const state = daemon.socketState.get(socket);
            if (!state) return;
            if (state.pendingToClient) {
              state.pendingToClient = flushPending(socket, state.pendingToClient);
            }
            if (!state.pendingToClient && state.pgSocket) {
              state.pgSocket.resume();
            }
          },
        },
      });
    } catch (err) {
      try { await this.pgManager.stop(); } catch { /* swallow */ }
      this.releaseLock();
      throw err;
    }

    // Restrict the socket to the owning user (some kernels honour mode
    // bits on AF_UNIX sockets, which makes our daemon refuse to even
    // accept from other UIDs without further auth).
    try { fs.chmodSync(this.controlSocketPath, 0o600); } catch { /* swallow */ }

    // Publish a libpq-compatible symlink so off-the-shelf clients can use
    // `psql -h <dir>` without knowing the `control.sock` name. Replace any
    // stale symlink left by a previous abnormal exit.
    try { fs.unlinkSync(this.libpqCompatPath); } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn?.({ err: e.message }, 'Failed to unlink stale libpq compat symlink');
      }
    }
    try {
      fs.symlinkSync(path.basename(this.controlSocketPath), this.libpqCompatPath);
    } catch (e) {
      this.logger.warn?.({ err: e.message }, 'Failed to publish libpq compat symlink');
    }

    this.logger.info?.({
      pid: process.pid,
      controlSocketPath: this.controlSocketPath,
      pidLockPath: this.pidLockPath,
      pgPort: this.pgManager.port,
    }, 'pgserve daemon listening');

    this.emit('listening');
    return this;
  }

  /**
   * Graceful shutdown: drain connections, stop PG, release lock + socket.
   */
  async stop() {
    if (this._stopping) return;
    this._stopping = true;

    this.logger.info?.('Stopping pgserve daemon');

    for (const socket of this.connections) {
      try { socket.end(); } catch { /* swallow */ }
    }
    this.connections.clear();

    if (this.server) {
      try { this.server.stop(); } catch { /* swallow */ }
      this.server = null;
    }

    try {
      await this.pgManager.stop();
    } catch (err) {
      this.logger.warn?.({ err: err.message }, 'PostgresManager.stop failed during daemon shutdown');
    }

    try { fs.unlinkSync(this.libpqCompatPath); } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn?.({ err: e.message }, 'Failed to unlink libpq compat symlink');
      }
    }

    try { fs.unlinkSync(this.controlSocketPath); } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn?.({ err: e.message }, 'Failed to unlink control socket');
      }
    }

    this.releaseLock();
    this._stopping = false;
    this.emit('stopped');
  }

  releaseLock() {
    if (!this._lockAcquired) return;
    try {
      // Only remove the lock if it still belongs to us. Defends against
      // a fast restart loop where another daemon raced in.
      const raw = fs.readFileSync(this.pidLockPath, 'utf8').trim();
      const owner = parseInt(raw, 10);
      if (Number.isInteger(owner) && owner === process.pid) {
        fs.unlinkSync(this.pidLockPath);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn?.({ err: e.message }, 'Failed to release daemon pid lock');
      }
    }
    this._lockAcquired = false;
  }

  installSignalHandlers() {
    if (this._signalHandlersInstalled) return;
    this._signalHandlersInstalled = true;
    const onSignal = async (sig) => {
      this.logger.info?.({ sig }, 'Received signal, draining daemon');
      try { await this.stop(); } catch { /* swallow */ }
      // Re-raise so the OS reports the right exit status. Use the default
      // disposition rather than process.exit(0): operators expect a
      // SIGTERM-killed daemon to exit with the corresponding code.
      process.exit(0);
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    process.on('SIGHUP', onSignal);
  }

  /**
   * Route a client connection through to the underlying PG Unix socket.
   *
   * Per-accept fingerprint derivation is live: SO_PEERCRED → /proc walk →
   * package.json hash, with a `connection_routed` audit emit. Fingerprint
   * info is parked on socketState so Group 4 (database-per-fingerprint)
   * can resolve the tenant DB without re-deriving on every byte.
   */
  handleSocketOpen(socket) {
    let fingerprint = null;
    try {
      fingerprint = handleControlAccept(socket);
    } catch (err) {
      this.logger.warn?.(
        { err: err?.message || String(err) },
        'Failed to derive peer fingerprint on accept',
      );
    }
    this.socketState.set(socket, {
      buffer: null,
      pgSocket: null,
      dbName: null,
      handshakeComplete: false,
      startupInProgress: false,
      pendingToPg: null,
      pendingToClient: null,
      fingerprint,
    });
    this.connections.add(socket);
    if (fingerprint) {
      this.emit('accept', { fingerprint, socket });
    }
  }

  handleSocketData(socket, data) {
    const state = this.socketState.get(socket);
    if (!state) return;

    if (state.handshakeComplete && state.pgSocket) {
      if (state.pendingToPg) {
        state.pendingToPg = Buffer.concat([state.pendingToPg, Buffer.from(data)]);
        socket.pause();
        return;
      }
      const written = state.pgSocket.write(data);
      if (written < data.byteLength) {
        state.pendingToPg = written === 0 ? Buffer.from(data) : Buffer.from(data.subarray(written));
        socket.pause();
      }
      return;
    }

    const incomingSize = state.buffer ? state.buffer.length + data.byteLength : data.byteLength;
    if (incomingSize > MAX_STARTUP_BUFFER_SIZE) {
      this.logger.warn?.(
        { incomingSize, limit: MAX_STARTUP_BUFFER_SIZE },
        'Pre-handshake buffer exceeded limit — closing connection',
      );
      socket.end();
      return;
    }
    if (state.buffer) {
      state.buffer = Buffer.concat([state.buffer, Buffer.from(data)]);
    } else {
      state.buffer = Buffer.from(data);
    }
    this.processStartupMessage(socket, state).catch((err) => {
      this.logger.error?.({ err: err.message }, 'processStartupMessage failed');
      try { socket.end(); } catch { /* swallow */ }
    });
  }

  async processStartupMessage(socket, state) {
    if (state.startupInProgress) return;
    const buffer = state.buffer;
    if (!buffer || buffer.length < 8) return;

    const messageLength = buffer.readUInt32BE(0);
    if (buffer.length < messageLength) return;

    const code = buffer.readUInt32BE(4);

    if (code === SSL_REQUEST_CODE || code === GSSAPI_REQUEST_CODE) {
      socket.write(Buffer.from('N'));
      state.buffer = buffer.length > messageLength ? buffer.subarray(messageLength) : null;
      return;
    }

    if (code === CANCEL_REQUEST_CODE) {
      socket.end();
      return;
    }

    if (code !== PROTOCOL_VERSION_3) {
      this.logger.warn?.({ code }, 'Unsupported protocol version on control socket');
      socket.end();
      return;
    }

    const startupMessage = buffer.subarray(0, messageLength);
    const dbName = extractDatabaseName(startupMessage);
    state.dbName = dbName;
    state.startupInProgress = true;

    try {
      if (this.autoProvision) {
        await this.pgManager.createDatabase(dbName);
      }

      const pgSocketPath = this.pgManager.getSocketPath();
      const daemon = this;
      const pgHandler = {
        data(_pgSocket, pgData) {
          if (state.pendingToClient) {
            state.pendingToClient = Buffer.concat([state.pendingToClient, Buffer.from(pgData)]);
            _pgSocket.pause();
            return;
          }
          const written = socket.write(pgData);
          if (written < pgData.byteLength) {
            state.pendingToClient = written === 0
              ? Buffer.from(pgData)
              : Buffer.from(pgData.subarray(written));
            _pgSocket.pause();
          }
        },
        open(pgSocket) {
          pgSocket.write(startupMessage);
          state.handshakeComplete = true;
        },
        close() {
          try { socket.end(); } catch { /* swallow */ }
        },
        error(_pgSocket, error) {
          daemon.logger.error?.({ dbName, err: error?.message || String(error) }, 'PG-side proxy socket error');
          try { socket.end(); } catch { /* swallow */ }
        },
        drain(_pgSocket) {
          if (state.pendingToPg) {
            state.pendingToPg = flushPending(_pgSocket, state.pendingToPg);
          }
          if (!state.pendingToPg) {
            socket.resume();
          }
        },
      };

      // Same #24 safety net as the router: socketPath might point at a
      // directory the PG manager has since cleaned up. Fall back to TCP
      // rather than hanging on a missing socket file.
      const useUnix = pgSocketPath && fs.existsSync(pgSocketPath);
      if (useUnix) {
        state.pgSocket = await Bun.connect({ unix: pgSocketPath, socket: pgHandler });
      } else {
        if (pgSocketPath && !useUnix) {
          this.logger.warn?.(
            { pgSocketPath, dbName },
            'PG Unix socket path stale — falling back to TCP',
          );
        }
        state.pgSocket = await Bun.connect({
          hostname: '127.0.0.1',
          port: this.pgManager.port,
          socket: pgHandler,
        });
      }

      this.emit('connection', { dbName, socket });
    } catch (err) {
      this.logger.error?.({ dbName, err: err?.message || String(err) }, 'Daemon connection error');
      try { socket.end(); } catch { /* swallow */ }
      this.emit('connection-error', { error: err, dbName });
    } finally {
      state.startupInProgress = false;
    }
  }

  handleSocketClose(socket) {
    const state = this.socketState.get(socket);
    if (state) {
      state.pendingToPg = null;
      state.pendingToClient = null;
      if (state.pgSocket) {
        try { state.pgSocket.end(); } catch { /* swallow */ }
      }
    }
    this.connections.delete(socket);
    this.socketState.delete(socket);
  }

  handleSocketError(socket, error) {
    const state = this.socketState.get(socket);
    if (error?.code !== 'ECONNRESET') {
      this.logger.error?.({ err: error?.message || String(error), dbName: state?.dbName }, 'Control socket error');
    }
    if (state) {
      state.pendingToPg = null;
      state.pendingToClient = null;
      if (state.pgSocket) {
        try { state.pgSocket.end(); } catch { /* swallow */ }
      }
    }
    this.connections.delete(socket);
    this.socketState.delete(socket);
  }

  getStats() {
    return {
      controlSocketPath: this.controlSocketPath,
      pidLockPath: this.pidLockPath,
      activeConnections: this.connections.size,
      pgPort: this.pgManager.port,
      postgres: this.pgManager.getStats(),
    };
  }
}

function flushPending(target, pending) {
  const written = target.write(pending);
  if (written === pending.byteLength) return null;
  if (written === 0) return pending;
  return pending.subarray(written);
}

/**
 * Convenience entry — used by the CLI subcommand.
 */
export async function startDaemon(options = {}) {
  const daemon = new PgserveDaemon(options);
  await daemon.start();
  return daemon;
}
