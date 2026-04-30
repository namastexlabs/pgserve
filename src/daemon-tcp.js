/**
 * pgserve daemon — opt-in TCP accept path (Group 6).
 *
 * Bound only when `pgserve daemon --listen <host:port>` is set. TCP peers
 * cannot use SO_PEERCRED, so identity is established via a bearer token
 * presented in `application_name` shaped `?fingerprint=<12hex>&token=<bearer>`.
 *
 * Methods are attached to `PgserveDaemon.prototype` from `daemon.js` so
 * the surface stays one cohesive class — the split is purely to honour
 * the 1000-line discipline (AGENTS.md §8).
 */

/* global Bun */
import fs from 'fs';
import { extractApplicationName, rewriteDatabaseName } from './protocol.js';
import { audit, AUDIT_EVENTS } from './audit.js';
import { verifyToken } from './control-db.js';
import { parseTcpAuth, hashToken } from './tokens.js';
import { flushPending } from './daemon-shared.js';

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
const GSSAPI_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;

const MAX_STARTUP_BUFFER_SIZE = 1024 * 1024; // 1 MiB — same bound as router.js

/**
 * Install the TCP accept handlers on PgserveDaemon.prototype.
 * Called once from daemon.js at module load.
 */
export function attachTcpHandlers(PgserveDaemon) {
  PgserveDaemon.prototype.bindTcpListener = bindTcpListener;
  PgserveDaemon.prototype.handleTcpOpen = handleTcpOpen;
  PgserveDaemon.prototype.handleTcpData = handleTcpData;
  PgserveDaemon.prototype.processTcpStartupMessage = processTcpStartupMessage;
  PgserveDaemon.prototype.handleTcpClose = handleTcpClose;
  PgserveDaemon.prototype.handleTcpError = handleTcpError;
}

async function bindTcpListener({ host, port }) {
  const daemon = this;
  return Bun.listen({
    hostname: host,
    port,
    socket: {
      data(socket, data) { daemon.handleTcpData(socket, data); },
      open(socket) { daemon.handleTcpOpen(socket); },
      close(socket) { daemon.handleTcpClose(socket); },
      error(socket, error) { daemon.handleTcpError(socket, error); },
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
}

function handleTcpOpen(socket) {
  // TCP peers cannot use SO_PEERCRED; identity is established via the
  // application_name token in the startup message.
  this.socketState.set(socket, {
    transport: 'tcp',
    buffer: null,
    pgSocket: null,
    dbName: null,
    handshakeComplete: false,
    startupInProgress: false,
    pendingToPg: null,
    pendingToClient: null,
    fingerprint: null,
    tokenId: null,
  });
  this.connections.add(socket);
}

function handleTcpData(socket, data) {
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
      'TCP pre-handshake buffer exceeded limit — closing connection',
    );
    socket.end();
    return;
  }
  state.buffer = state.buffer ? Buffer.concat([state.buffer, Buffer.from(data)]) : Buffer.from(data);

  this.processTcpStartupMessage(socket, state).catch((err) => {
    this.logger.error?.({ err: err.message }, 'TCP processStartupMessage failed');
    try { socket.end(); } catch { /* swallow */ }
  });
}

async function processTcpStartupMessage(socket, state) {
  if (state.startupInProgress) return;
  const buffer = state.buffer;
  if (!buffer || buffer.length < 8) return;
  const messageLength = buffer.readUInt32BE(0);
  if (buffer.length < messageLength) return;
  const code = buffer.readUInt32BE(4);

  if (code === SSL_REQUEST_CODE || code === GSSAPI_REQUEST_CODE) {
    socket.write(Buffer.from('N'));
    state.buffer = buffer.length > messageLength ? buffer.subarray(messageLength) : null;
    if (state.buffer) await processTcpStartupMessage.call(this, socket, state);
    return;
  }
  if (code === CANCEL_REQUEST_CODE) {
    socket.end();
    return;
  }
  if (code !== PROTOCOL_VERSION_3) {
    this.logger.warn?.({ code }, 'TCP unsupported protocol version');
    socket.end();
    return;
  }

  const startupMessage = buffer.subarray(0, messageLength);
  const applicationName = extractApplicationName(startupMessage);
  const auth = parseTcpAuth(applicationName);
  state.startupInProgress = true;

  // Validate before opening any PG socket. The denied path emits exactly
  // one audit event then closes — the peer gets no oracle distinguishing
  // "unknown fingerprint" from "bad token".
  let validated = null;
  try {
    if (auth && this._adminClient) {
      const tokenHash = hashToken(auth.token);
      validated = await verifyToken(this._adminClient, {
        fingerprint: auth.fingerprint,
        tokenHash,
      }, { timeoutMs: this.adminLookupTimeoutMs });
    }
  } catch (err) {
    this.logger.warn?.({ err: err.message }, 'verifyToken failed');
    validated = null;
  }

  if (!validated) {
    audit(AUDIT_EVENTS.TCP_TOKEN_DENIED, {
      fingerprint: auth?.fingerprint || null,
      remote_address: socket.remoteAddress || null,
      reason: !auth ? 'missing_or_malformed_application_name' : 'token_unknown',
    });
    try { socket.end(); } catch { /* swallow */ }
    state.startupInProgress = false;
    return;
  }

  state.fingerprint = auth.fingerprint;
  state.tokenId = validated.tokenId;
  state.dbName = validated.databaseName;

  audit(AUDIT_EVENTS.TCP_TOKEN_USED, {
    fingerprint: auth.fingerprint,
    token_id: validated.tokenId,
    database: validated.databaseName,
    remote_address: socket.remoteAddress || null,
  });

  // Force the peer into its fingerprint's database — even if the libpq
  // client asked for something else. Drop application_name on the way
  // through: the auth blob easily exceeds Postgres' 63-char NAMEDATALEN
  // and would otherwise trigger a truncation NOTICE on every connect.
  let outgoingStartup;
  try {
    outgoingStartup = rewriteDatabaseName(startupMessage, validated.databaseName, {
      dropParams: ['application_name'],
    });
  } catch (err) {
    this.logger.error?.({ err: err.message }, 'rewriteDatabaseName failed for TCP peer');
    try { socket.end(); } catch { /* swallow */ }
    state.startupInProgress = false;
    return;
  }

  try {
    if (this.autoProvision) {
      await this.pgManager.createDatabase(validated.databaseName);
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
        daemon.logger.error?.(
          { dbName: validated.databaseName, err: error?.message || String(error) },
          'TCP-side PG proxy socket error',
        );
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

    const useUnix = pgSocketPath && fs.existsSync(pgSocketPath);
    if (useUnix) {
      state.pgSocket = await Bun.connect({ unix: pgSocketPath, socket: pgHandler });
    } else {
      state.pgSocket = await Bun.connect({
        hostname: '127.0.0.1',
        port: this.pgManager.port,
        socket: pgHandler,
      });
    }
    this.emit('tcp-connection', { dbName: validated.databaseName, fingerprint: auth.fingerprint });
  } catch (err) {
    this.logger.error?.(
      { dbName: validated.databaseName, err: err?.message || String(err) },
      'TCP daemon connection error',
    );
    try { socket.end(); } catch { /* swallow */ }
    this.emit('connection-error', { error: err, dbName: validated.databaseName });
  } finally {
    state.startupInProgress = false;
  }
}

function handleTcpClose(socket) {
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

function handleTcpError(socket, error) {
  if (error?.code !== 'ECONNRESET') {
    this.logger.error?.({ err: error?.message || String(error) }, 'TCP socket error');
  }
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
