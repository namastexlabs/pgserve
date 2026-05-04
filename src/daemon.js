/**
 * autopg/pgserve daemon — singleton PG lifecycle owner.
 *
 * Post-cutover (autopg Group 4): the daemon no longer multiplexes wire
 * traffic. PostgreSQL is reachable directly on its native Unix socket
 * (per-app SCRAM credential delivered via ~/.autopg/<app>.env). The daemon
 * exists to (a) own the PG process under a singleton PID lock, (b) provision
 * the meta schema and admin client, and (c) install GC sweep triggers.
 *
 * What the daemon NO LONGER does (deleted with src/{router,protocol,
 * pg-wire,daemon-control,daemon-tcp,sdk}.js):
 *   - Bun.listen() control socket / TCP listener
 *   - Per-connection state tracking + handshake watchdog
 *   - StartupMessage parsing + database rewriting
 *   - Token-authenticated TCP gateway
 *   - libpq compat symlink (clients now point at PG's socket directly)
 *
 * Singleton enforcement uses a PID lock file (`pgserve.pid`) co-located with
 * the legacy control-socket dir. A second daemon invocation refuses with
 * the live PID; a stale lock (process gone) is cleaned up automatically on
 * next boot.
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
import { installSweepTriggers } from './gc.js';

/**
 * Resolve the directory that holds the daemon's PID lock and admin discovery
 * file. `$XDG_RUNTIME_DIR/pgserve` when XDG is set (the systemd / freedesktop
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

// `resolveLibpqCompatPath` was removed in the autopg cutover (the libpq
// compat symlink it computed is no longer published — apps target PG's
// native socket via `pgManager.getSocketPath()` directly).

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
 */
export function acquirePidLock({ pidLockPath, logger }) {
  ensureDir(path.dirname(pidLockPath));

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

      logger?.warn?.(
        { pidLockPath, stalePid },
        'Found stale daemon PID lock, cleaning up before retry',
      );
      try {
        fs.unlinkSync(pidLockPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }
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
    return { stopped: false, reason: 'stale-pid', pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, reason: 'signal-failed', pid, error: err.message };
  }

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
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * The daemon. Owns one PostgresManager and the singleton PID lock.
 *
 * After autopg cutover the daemon does NOT bind any client-facing socket.
 * Apps connect to PG's native Unix socket (`pgManager.getSocketPath()`)
 * with their per-app SCRAM credential.
 */
export class PgserveDaemon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.controlSocketDir = options.controlSocketDir || resolveControlSocketDir();
    this.pidLockPath = options.pidLockPath || resolvePidLockPath(this.controlSocketDir);
    this.maxConnections = options.maxConnections || 1000;
    this.autoProvision = options.autoProvision !== false;
    this.baseDir = options.baseDir || null;
    this.useRam = options.useRam || false;
    this.auditLogFile = options.auditLogFile || null;
    this.auditTarget = options.auditTarget || null;
    // Group 4 (autopg-v22): fingerprint enforcement is on by default; the
    // kill-switch env var (`PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`) flips
    // it off and is surfaced as a deprecation warning at start().
    this.enforcementDisabled = options.enforcementDisabled !== undefined
      ? !!options.enforcementDisabled
      : isFingerprintEnforcementDisabled();
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

    this._lockAcquired = false;
    this._signalHandlersInstalled = false;
    this._stopping = false;
    // Lazy-initialised admin DB client.
    this._adminClient = null;
    this.adminIdleTimeout = options.adminIdleTimeout ?? 300;
    this.adminQueryTimeoutMs = options.adminQueryTimeoutMs ?? 0;
    this.adminLookupTimeoutMs = options.adminLookupTimeoutMs ?? 5000;
    // Group 5: GC sweep handle ({stop, sweep}). Installed once the admin
    // client is up and torn down on stop().
    this._gcHandle = null;
    this.gcEnabled = options.gcEnabled !== false;
    this.gcOptions = options.gcOptions || {};
  }

  /**
   * Start the daemon: acquire singleton lock, boot PG, init admin schema.
   *
   * Throws an Error tagged `EALREADYRUNNING` when another live daemon
   * already owns the lock, so the CLI can render the
   * "already running, pid N" message and `exit(1)` cleanly.
   */
  async start() {
    if (this._lockAcquired) {
      this.logger.warn?.({ pid: process.pid }, 'PgserveDaemon.start called while already running');
      return this;
    }

    ensureDir(this.controlSocketDir);

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
      logger: this.logger,
    });
    if (!lock.acquired) {
      const err = new Error(`pgserve daemon already running, pid ${lock.pid}`);
      err.code = 'EALREADYRUNNING';
      err.pid = lock.pid;
      throw err;
    }
    this._lockAcquired = true;

    try { fs.chmodSync(this.controlSocketDir, 0o700); } catch { /* swallow */ }

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
      this.releaseLock();
      throw err;
    }

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
        'admin DB init failed — autopg admin operations will be unavailable',
      );
    }

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
      pidLockPath: this.pidLockPath,
      pgPort: this.pgManager.port,
      pgSocketDir: this.pgManager.socketDir,
    }, 'pgserve daemon listening');

    this.emit('listening');
    return this;
  }

  /**
   * Graceful shutdown: stop PG, release lock.
   */
  async stop() {
    if (this._stopping) return;
    this._stopping = true;

    this.logger.info?.('Stopping pgserve daemon');

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

    this.releaseLock();
    this._stopping = false;
    this.emit('stopped');
  }

  releaseLock() {
    if (!this._lockAcquired) return;
    try {
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
      process.exit(0);
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    process.on('SIGHUP', onSignal);
  }

  getStats() {
    return {
      pidLockPath: this.pidLockPath,
      pgPort: this.pgManager.port,
      pgSocketDir: this.pgManager.socketDir,
      postgres: this.pgManager.getStats(),
    };
  }
}

/**
 * Convenience entry — used by the CLI subcommand.
 */
export async function startDaemon(options = {}) {
  const daemon = new PgserveDaemon(options);
  await daemon.start();
  return daemon;
}
