/**
 * pgserve daemon — Unix control-socket accept path (Group 2 + Group 4).
 *
 * Accepted on `$XDG_RUNTIME_DIR/pgserve/control.sock`, peers identify via
 * SO_PEERCRED → /proc walk → package.json hash, then route into the
 * fingerprint's tenant database. The plain TCP path lives in
 * `daemon-tcp.js` and shares the same prototype owner.
 *
 * Methods are attached to `PgserveDaemon.prototype` from `daemon.js` so
 * the surface is one cohesive class — splitting modules here is purely
 * to honour the 1000-line discipline (AGENTS.md §8).
 */

/* global Bun */
import fs from 'fs';
import { extractDatabaseName, rewriteDatabaseName, buildErrorResponse } from './protocol.js';
import { handleControlAccept, readPersistFlag } from './fingerprint.js';
import { audit, AUDIT_EVENTS } from './audit.js';
import {
  findRowByFingerprint,
  recordDbCreated,
  touchLastConnection,
  markPersist,
} from './control-db.js';
import {
  resolveTenantDatabaseName,
} from './tenancy.js';
import { flushPending } from './daemon-shared.js';

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
const GSSAPI_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

const MAX_STARTUP_BUFFER_SIZE = 1024 * 1024; // 1 MiB — same bound as router.js

/**
 * Install the Unix control-socket handlers on PgserveDaemon.prototype.
 * Called once from daemon.js at module load.
 */
export function attachControlHandlers(PgserveDaemon) {
  PgserveDaemon.prototype.handleSocketOpen = handleSocketOpen;
  PgserveDaemon.prototype.handleSocketData = handleSocketData;
  PgserveDaemon.prototype.processStartupMessage = processStartupMessage;
  PgserveDaemon.prototype.handleSocketClose = handleSocketClose;
  PgserveDaemon.prototype.handleSocketError = handleSocketError;
  PgserveDaemon.prototype.resolveTenantDatabase = resolveTenantDatabase;
}

/**
 * Per-accept fingerprint derivation is live: SO_PEERCRED → /proc walk →
 * package.json hash. Fingerprint info is parked on socketState so the
 * tenant lookup in processStartupMessage doesn't re-derive on every byte.
 */
function handleSocketOpen(socket) {
  let fingerprint = null;
  try {
    const opts = this._fingerprintAcceptOpts ? (this._fingerprintAcceptOpts(socket) || {}) : {};
    fingerprint = handleControlAccept(socket, opts);
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
    // Wall-clock timestamp when this socket was accepted. The watchdog
    // installed by PgserveDaemon.start() forcibly closes any socket that
    // hasn't completed its postgres handshake within
    // PGSERVE_HANDSHAKE_DEADLINE_MS. Without this, a peer that connects
    // and never sends the StartupMessage occupies the connection slot
    // forever — the file-descriptor leak documented in pgserve#45.
    acceptedAt: Date.now(),
  });
  this.connections.add(socket);
  if (fingerprint) {
    this.emit('accept', { fingerprint, socket });
  }
}

function handleSocketData(socket, data) {
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

async function processStartupMessage(socket, state) {
  if (state.startupInProgress) return;
  const buffer = state.buffer;
  if (!buffer || buffer.length < 8) return;

  const messageLength = buffer.readUInt32BE(0);
  if (buffer.length < messageLength) return;

  const code = buffer.readUInt32BE(4);

  if (code === SSL_REQUEST_CODE || code === GSSAPI_REQUEST_CODE) {
    socket.write(Buffer.from('N'));
    state.buffer = buffer.length > messageLength ? buffer.subarray(messageLength) : null;
    if (state.buffer) await processStartupMessage.call(this, socket, state);
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
  const requestedDb = extractDatabaseName(startupMessage);
  state.dbName = requestedDb;
  state.startupInProgress = true;

  try {
    const resolution = await this.resolveTenantDatabase(state, requestedDb);
    if (resolution.deny) {
      const errFrame = buildErrorResponse({
        severity: 'FATAL',
        sqlstate: '28P01',
        message: resolution.message,
      });
      try {
        // Bun's TCPSocket.end(data) writes then closes atomically — using
        // write()+end() can race the FIN past the data on some kernels and
        // leave the peer waiting for AuthOK indefinitely.
        socket.end(errFrame);
      } catch { /* swallow */ }
      this.emit('connection-denied', {
        fingerprint: state.fingerprint?.fingerprint || null,
        requested: requestedDb,
        owned: resolution.ownedDatabaseName,
      });
      return;
    }

    const dbName = resolution.databaseName;
    state.dbName = dbName;
    const outgoingStartup = (dbName !== requestedDb)
      ? rewriteDatabaseName(startupMessage, dbName)
      : startupMessage;

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
        pgSocket.write(outgoingStartup);
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
    this.logger.error?.({ dbName: state.dbName, err: err?.message || String(err) }, 'Daemon connection error');
    try { socket.end(); } catch { /* swallow */ }
    this.emit('connection-error', { error: err, dbName: state.dbName });
  } finally {
    state.startupInProgress = false;
  }
}

/**
 * Group 4 — wire identity to tenancy.
 *
 * On first connect: provision a per-fingerprint database, audit the create.
 * On reconnect: bump last_connection_at + liveness_pid.
 * On cross-tenant attempt: deny with SQLSTATE 28P01, OR (when the kill
 * switch is on) bypass and audit `enforcement_kill_switch_used`.
 */
async function resolveTenantDatabase(state, requestedDb) {
  const fp = state.fingerprint;
  // No fingerprint (FFI unavailable, accept hook failed) or no admin
  // client (init failed) → behave as v1: route the requested name through
  // unchanged. Tenancy enforcement is best-effort, never load-bearing for
  // basic connectivity.
  if (!fp || !this._adminClient) {
    return { databaseName: requestedDb };
  }

  const { fingerprint, name, uid, pid, packageRealpath } = fp;
  const lookupOpts = { timeoutMs: this.adminLookupTimeoutMs };

  let row = null;
  try {
    row = await findRowByFingerprint(this._adminClient, fingerprint, lookupOpts);
  } catch (err) {
    this.logger.warn?.(
      { err: err?.message || String(err), fingerprint },
      'pgserve_meta lookup failed — falling back to requested DB',
    );
    return { databaseName: requestedDb };
  }

  // Group 5: read pgserve.persist from the resolved package.json so the row
  // we (re)write reflects the peer's lifecycle preference. Script-mode peers
  // never get persist=true (no package.json to opt in from).
  const persistRequested = packageRealpath ? readPersistFlag(packageRealpath) : false;

  if (!row) {
    const newName = resolveTenantDatabaseName({ name, fingerprint });
    try {
      await this.pgManager.createDatabase(newName);
      await recordDbCreated(this._adminClient, {
        databaseName: newName,
        fingerprint,
        peerUid: typeof uid === 'number' ? uid : -1,
        packageRealpath: packageRealpath || null,
        livenessPid: typeof pid === 'number' && pid > 0 ? pid : null,
        persist: persistRequested,
      }, lookupOpts);
      audit(AUDIT_EVENTS.DB_CREATED, {
        database: newName,
        fingerprint,
        peer_uid: uid,
        peer_pid: pid,
        package_realpath: packageRealpath || null,
        name,
        persist: persistRequested,
      });
    } catch (err) {
      this.logger.error?.(
        { err: err?.message || String(err), fingerprint, dbName: newName },
        'Failed to provision per-fingerprint database',
      );
      throw err;
    }
    row = { databaseName: newName, fingerprint, peerUid: uid, allowedTokens: [] };
  } else {
    try {
      await touchLastConnection(this._adminClient, {
        databaseName: row.databaseName,
        livenessPid: typeof pid === 'number' && pid > 0 ? pid : null,
      }, lookupOpts);
    } catch (err) {
      this.logger.warn?.(
        { err: err?.message || String(err), database: row.databaseName },
        'touchLastConnection failed (non-fatal)',
      );
    }
    // Group 5: keep persist in sync when the peer's package.json toggles the
    // flag between connections — the previous run might have started without
    // persist:true and the operator just added it (or vice versa).
    try {
      await markPersist(this._adminClient, row.databaseName, persistRequested, lookupOpts);
    } catch (err) {
      this.logger.warn?.(
        { err: err?.message || String(err), database: row.databaseName },
        'markPersist failed (non-fatal)',
      );
    }
  }

  // Enforcement: peer asked for an explicit database that isn't theirs.
  // libpq's default `database = user` is treated the same as `postgres` —
  // both are "I don't care, give me whatever you have for me", so we
  // silently route them into the fingerprint's DB.
  const requested = (typeof requestedDb === 'string' && requestedDb.length > 0)
    ? requestedDb
    : 'postgres';
  const isImplicit = requested === 'postgres' || requested === row.databaseName;
  if (!isImplicit) {
    if (this.enforcementDisabled) {
      audit(AUDIT_EVENTS.ENFORCEMENT_KILL_SWITCH_USED, {
        fingerprint,
        peer_uid: uid,
        peer_pid: pid,
        requested_database: requested,
        owned_database: row.databaseName,
      });
      try { await this.pgManager.createDatabase(requested); } catch { /* swallow */ }
      return { databaseName: requested };
    }
    audit(AUDIT_EVENTS.CONNECTION_DENIED_FINGERPRINT_MISMATCH, {
      fingerprint,
      peer_uid: uid,
      peer_pid: pid,
      requested_database: requested,
      owned_database: row.databaseName,
    });
    return {
      deny: true,
      ownedDatabaseName: row.databaseName,
      message:
        `database fingerprint mismatch: peer ${fingerprint} owns ` +
        `${row.databaseName}, requested ${requested}`,
    };
  }

  return { databaseName: row.databaseName };
}

function handleSocketClose(socket) {
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

function handleSocketError(socket, error) {
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
