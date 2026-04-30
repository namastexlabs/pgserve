/**
 * pgserve daemon — singleton control-socket server (orchestrator).
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
 * Module layout (split for AGENTS.md §8 1000-line discipline):
 *   - daemon.js (this file)   — class shell, lifecycle, lock, signal handlers,
 *     listener wiring, public exports.
 *   - daemon-control.js       — Unix accept hooks: handleSocketOpen/Data/Close/
 *     Error, processStartupMessage, resolveTenantDatabase (Group 2 + Group 4).
 *   - daemon-tcp.js           — Optional TCP accept hooks + token verify
 *     (Group 6).
 *   - daemon-shared.js        — flushPending helper shared by both paths.
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
import { createLogger } from './logger.js';
import { initFingerprintFfi } from './fingerprint.js';
import { configureAudit } from './audit.js';
import { ensureMetaSchema } from './control-db.js';
import { createAdminClient, writeAdminDiscovery, removeAdminDiscovery } from './admin-client.js';
import {
  isFingerprintEnforcementDisabled,
  KILL_SWITCH_ENV,
} from './tenancy.js';
import { flushPending } from './daemon-shared.js';
import { attachControlHandlers } from './daemon-control.js';
import { attachTcpHandlers } from './daemon-tcp.js';
import { installSweepTriggers } from './gc.js';

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
 * Accept-path methods (handleSocketOpen, handleTcpOpen, …) live in the
 * daemon-control.js / daemon-tcp.js modules and are mixed into the
 * prototype below.
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
    // Group 6: opt-in TCP binds. Each entry is `{host, port}`. Empty array
    // (the default) means "Unix socket only" — no TCP port is bound.
    this.tcpListens = normalizeTcpListens(options.tcpListens);
    // Group 4: fingerprint enforcement is on by default; the kill-switch env
    // var (`PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`) flips it off and is
    // surfaced as a deprecation warning at start(). Tests pass an explicit
    // boolean override.
    this.enforcementDisabled = options.enforcementDisabled !== undefined
      ? !!options.enforcementDisabled
      : isFingerprintEnforcementDisabled();
    // Group 4 test seam: per-accept overrides for fingerprint derivation.
    // Production omits this and the daemon walks `/proc/$pid/cwd` for real.
    this._fingerprintAcceptOpts = typeof options._fingerprintAcceptOpts === 'function'
      ? options._fingerprintAcceptOpts
      : null;
    this.logger = options.logger || createLogger({ level: options.logLevel || 'info' });

    this.pgManager = options.pgManager || new PostgresManager({
      dataDir: this.baseDir,
      port: options.pgPort ?? 0,
      logger: this.logger.child ? this.logger.child({ component: 'postgres' }) : this.logger,
      useRam: this.useRam,
      enablePgvector: options.enablePgvector || false,
    });

    // Forward unexpected backend deaths to wrapper-level supervisors. A clean
    // stop() sets PostgresManager._stopping=true so the event arrives with
    // expected=true and we leave the daemon alone; an external SIGKILL / OOM
    // / segfault arrives with expected=false and we re-emit so the wrapper
    // can exit non-zero and let a process supervisor (genie serve, pm2,
    // systemd) restart us cleanly. See pgserve#45.
    this.pgManager.on('backendExited', (info) => {
      if (!info.expected) {
        this.emit('backendDiedUnexpectedly', info);
      }
    });

    this.server = null;
    this.tcpServers = [];
    this.connections = new Set();
    this.socketState = new WeakMap();
    this._lockAcquired = false;
    this._signalHandlersInstalled = false;
    this._stopping = false;
    // Lazy-initialised admin DB client (Group 6 token validation).
    this._adminClient = null;
    this.adminIdleTimeout = options.adminIdleTimeout ?? 300;
    this.adminQueryTimeoutMs = options.adminQueryTimeoutMs ?? 0;
    this.adminLookupTimeoutMs = options.adminLookupTimeoutMs ?? 5000;
    // Group 5: GC sweep handle ({stop, sweep}). Installed once the admin
    // client is up and torn down on stop().
    this._gcHandle = null;
    // Group 5 test seam — opt out of the boot sweep / hourly timer when
    // tests want to drive sweeps manually. Default: enabled.
    this.gcEnabled = options.gcEnabled !== false;
    this.gcOptions = options.gcOptions || {};

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

    // Group 4: surface the kill switch loudly at boot. The audit log records
    // every bypassed connection later, but operators should see this in
    // the daemon's own stderr the moment the process starts.
    if (this.enforcementDisabled) {
      const msg =
        `[pgserve] WARNING: ${KILL_SWITCH_ENV}=1 is set — fingerprint ` +
        `enforcement is DISABLED. Cross-tenant connections will be ` +
        `permitted. This kill switch is deprecated and will be removed ` +
        `in pgserve v3.`;
      try { process.stderr.write(`${msg}\n`); } catch { /* swallow */ }
      this.logger.warn?.({ env: KILL_SWITCH_ENV }, 'Fingerprint enforcement disabled — deprecated kill switch in use');
    }

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

    // Group 6: open the admin DB client + provision the meta schema before
    // we accept any connection that might rely on it (TCP token verify).
    try {
      this._adminClient = await createAdminClient({
        socketDir: this.pgManager.socketDir,
        port: this.pgManager.port,
        idleTimeout: this.adminIdleTimeout,
        queryTimeoutMs: this.adminQueryTimeoutMs,
      });
      await ensureMetaSchema(this._adminClient);
      writeAdminDiscovery({
        controlSocketDir: this.controlSocketDir,
        socketDir: this.pgManager.socketDir,
        port: this.pgManager.port,
      });
    } catch (err) {
      this.logger.warn?.(
        { err: err?.message || String(err) },
        'admin DB init failed — TCP listen will refuse connections',
      );
    }

    // Group 6: bind any opt-in TCP listeners. Errors here are fatal — if the
    // operator asked for TCP they want to know it failed (port collision,
    // EACCES) rather than silently fall back to Unix-only.
    for (const listen of this.tcpListens) {
      const tcp = await this.bindTcpListener(listen);
      this.tcpServers.push(tcp);
    }

    // Group 5: install GC sweep triggers (boot + hourly + on-connect sample)
    // once the admin client is provisioned. Disabled when gcEnabled=false
    // (tests that drive sweeps manually) or when no admin client exists.
    if (this.gcEnabled && this._adminClient) {
      try {
        this._gcHandle = installSweepTriggers(this, {
          adminClient: this._adminClient,
          ...this.gcOptions,
        });
      } catch (err) {
        this.logger.warn?.(
          { err: err?.message || String(err) },
          'GC sweep install failed — orphan reaping disabled',
        );
      }
    }

    this.logger.info?.({
      pid: process.pid,
      controlSocketPath: this.controlSocketPath,
      pidLockPath: this.pidLockPath,
      pgPort: this.pgManager.port,
      tcpListens: this.tcpListens,
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

    // Group 6: tear down opt-in TCP listeners.
    for (const tcp of this.tcpServers) {
      try { tcp.stop(); } catch { /* swallow */ }
    }
    this.tcpServers = [];

    // Group 5: detach GC triggers before the admin client closes so an
    // in-flight sweep doesn't try to query a closed connection.
    if (this._gcHandle) {
      try { await this._gcHandle.stop(); } catch { /* swallow */ }
      this._gcHandle = null;
    }

    if (this._adminClient) {
      try { await this._adminClient.end(); } catch { /* swallow */ }
      this._adminClient = null;
    }
    try {
      removeAdminDiscovery(this.controlSocketDir);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.logger.warn?.({ err: e.message }, 'Failed to remove admin discovery file');
      }
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

// Mix the accept-path handlers (Unix + TCP) into the prototype. Done at
// module load so `new PgserveDaemon()` always has them — same observable
// surface as the pre-split file.
attachControlHandlers(PgserveDaemon);
attachTcpHandlers(PgserveDaemon);

/**
 * Normalise the `--listen` form. Accepts:
 *   - omitted / null / [] → no TCP listeners
 *   - "5432"              → bind 0.0.0.0:5432
 *   - ":5432"             → bind 0.0.0.0:5432
 *   - "127.0.0.1:5432"    → bind localhost only
 *   - array of any of the above
 *
 * Returns an array of `{host, port}` objects. Throws on garbage input.
 */
export function normalizeTcpListens(listens) {
  if (listens === undefined || listens === null) return [];
  const arr = Array.isArray(listens) ? listens : [listens];
  return arr.filter(Boolean).map(parseSingleListen);
}

function parseSingleListen(spec) {
  if (typeof spec === 'object' && typeof spec.port === 'number') {
    return { host: spec.host || '0.0.0.0', port: spec.port };
  }
  if (typeof spec !== 'string') {
    throw new Error(`pgserve daemon --listen: bad spec ${JSON.stringify(spec)}`);
  }
  let s = spec.trim();
  if (s.startsWith(':')) s = s.slice(1);
  let host = '0.0.0.0';
  let portText = s;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1) {
    host = s.slice(0, lastColon);
    portText = s.slice(lastColon + 1);
  }
  const port = parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`pgserve daemon --listen: invalid port "${spec}"`);
  }
  return { host: host || '0.0.0.0', port };
}

/**
 * Convenience entry — used by the CLI subcommand.
 */
export async function startDaemon(options = {}) {
  const daemon = new PgserveDaemon(options);
  await daemon.start();
  return daemon;
}
