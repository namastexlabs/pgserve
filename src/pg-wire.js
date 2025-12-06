/**
 * PostgreSQL Wire Protocol Client
 *
 * Native Bun implementation for PostgreSQL connections using Bun.connect().
 * Implements: Startup, Authentication (MD5/trust), Simple Query, COPY TO/FROM.
 *
 * Protocol Reference: https://www.postgresql.org/docs/current/protocol.html
 */

import { createHash } from 'crypto';

// PostgreSQL Protocol Version 3.0
const PROTOCOL_VERSION = 196608;

// Frontend (client → server) message codes
const FE = {
  Query: 0x51,           // 'Q' - Simple query
  Terminate: 0x58,       // 'X' - Connection termination
  PasswordMessage: 0x70, // 'p' - Password response
  CopyData: 0x64,        // 'd' - COPY data chunk
  CopyDone: 0x63,        // 'c' - COPY complete
  CopyFail: 0x66,        // 'f' - COPY failed
};

// Backend (server → client) message codes
const BE = {
  AuthenticationRequest: 0x52, // 'R' - Authentication request/ok
  BackendKeyData: 0x4b,        // 'K' - Process ID and secret key
  ParameterStatus: 0x53,       // 'S' - Server parameter change
  ReadyForQuery: 0x5a,         // 'Z' - Ready for next query
  RowDescription: 0x54,        // 'T' - Column metadata
  DataRow: 0x44,               // 'D' - Row data
  CommandComplete: 0x43,       // 'C' - Command finished
  ErrorResponse: 0x45,         // 'E' - Error
  NoticeResponse: 0x4e,        // 'N' - Warning/notice
  CopyOutResponse: 0x48,       // 'H' - COPY TO started
  CopyInResponse: 0x47,        // 'G' - COPY FROM ready
  CopyDone: 0x63,              // 'c' - Server COPY complete
  EmptyQueryResponse: 0x49,    // 'I' - Empty query
};

// Authentication types
const AUTH = {
  Ok: 0,
  CleartextPassword: 3,
  MD5Password: 5,
  SASL: 10,
  SASLContinue: 11,
  SASLFinal: 12,
};

/**
 * PostgreSQL Wire Protocol Client
 *
 * @example
 * const client = new PgWireClient({
 *   hostname: '127.0.0.1',
 *   port: 5432,
 *   database: 'mydb',
 *   username: 'postgres',
 *   password: 'postgres'
 * });
 * await client.connect();
 * const rows = await client.query('SELECT * FROM users');
 * client.close();
 */
export class PgWireClient {
  constructor(options = {}) {
    this.hostname = options.hostname || '127.0.0.1';
    this.port = options.port || 5432;
    this.unix = options.unix || null;
    this.database = options.database || 'postgres';
    this.username = options.username || 'postgres';
    this.password = options.password || 'postgres';

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.state = 'disconnected';

    // Promise management for async operations
    this._connectResolve = null;
    this._connectReject = null;
    this._queryResolve = null;
    this._queryReject = null;
    this._copyResolve = null;
    this._copyReject = null;

    // Query result accumulation
    this._columns = [];
    this._rows = [];
    this._commandTag = '';

    // COPY streaming
    this._copyChunks = [];
    this._copyCallback = null;

    // Backend key data (for cancel requests)
    this.processId = null;
    this.secretKey = null;
  }

  /**
   * Connect to PostgreSQL server
   * @returns {Promise<void>}
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      const connectOpts = this.unix
        ? { unix: this.unix }
        : { hostname: this.hostname, port: this.port };

      const client = this;

      Bun.connect({
        ...connectOpts,
        socket: {
          open(socket) {
            client.socket = socket;
            client.state = 'startup';
            // Send startup message
            const startup = client._buildStartupMessage();
            socket.write(startup);
          },
          data(socket, data) {
            client._onData(data);
          },
          close() {
            client._onClose();
          },
          error(socket, err) {
            client._onError(err);
          },
          drain() {
            // Handle backpressure if needed
          }
        }
      }).catch(reject);
    });
  }

  /**
   * Build PostgreSQL startup message
   * @private
   */
  _buildStartupMessage() {
    const params = `user\0${this.username}\0database\0${this.database}\0\0`;
    const len = 4 + 4 + params.length;
    const buf = Buffer.alloc(len);
    buf.writeUInt32BE(len, 0);
    buf.writeUInt32BE(PROTOCOL_VERSION, 4);
    buf.write(params, 8);
    return buf;
  }

  /**
   * Handle incoming data
   * @private
   */
  _onData(data) {
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);

    // Process complete messages
    this._processMessages();
  }

  /**
   * Process buffered messages
   * @private
   */
  _processMessages() {
    while (this.buffer.length >= 5) {
      const type = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      const totalLength = 1 + length;

      if (this.buffer.length < totalLength) {
        break; // Wait for more data
      }

      const payload = this.buffer.subarray(5, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      this._handleMessage(type, payload);
    }
  }

  /**
   * Handle a single message
   * @private
   */
  _handleMessage(type, payload) {
    switch (type) {
      case BE.AuthenticationRequest:
        this._handleAuth(payload);
        break;

      case BE.BackendKeyData:
        this.processId = payload.readUInt32BE(0);
        this.secretKey = payload.readUInt32BE(4);
        break;

      case BE.ParameterStatus:
        // Server parameter - ignore for now
        break;

      case BE.ReadyForQuery:
        this._handleReadyForQuery(payload);
        break;

      case BE.RowDescription:
        this._handleRowDescription(payload);
        break;

      case BE.DataRow:
        this._handleDataRow(payload);
        break;

      case BE.CommandComplete:
        this._commandTag = payload.toString('utf8', 0, payload.indexOf(0));
        break;

      case BE.ErrorResponse:
        this._handleError(payload);
        break;

      case BE.NoticeResponse:
        // Warning - ignore for now
        break;

      case BE.EmptyQueryResponse:
        // Empty query - no rows
        break;

      case BE.CopyOutResponse:
        this._handleCopyOutResponse(payload);
        break;

      case BE.CopyInResponse:
        this._handleCopyInResponse(payload);
        break;

      case BE.CopyDone:
        // Server confirms COPY complete
        break;

      case FE.CopyData:
        // This is actually BE CopyData (same code)
        this._handleCopyData(payload);
        break;
    }
  }

  /**
   * Handle authentication request
   * @private
   */
  _handleAuth(payload) {
    const authType = payload.readUInt32BE(0);

    switch (authType) {
      case AUTH.Ok:
        this.state = 'authenticated';
        break;

      case AUTH.CleartextPassword:
        this._sendPassword(this.password);
        break;

      case AUTH.MD5Password:
        const salt = payload.subarray(4, 8);
        const hash = this._md5Auth(this.username, this.password, salt);
        this._sendPassword('md5' + hash);
        break;

      case AUTH.SASL:
        // SCRAM-SHA-256 not yet implemented
        this._rejectConnect(new Error('SCRAM-SHA-256 authentication not yet implemented'));
        break;

      default:
        this._rejectConnect(new Error(`Unsupported authentication type: ${authType}`));
    }
  }

  /**
   * Compute MD5 password hash
   * @private
   */
  _md5Auth(user, password, salt) {
    // md5(md5(password + user) + salt)
    const inner = createHash('md5')
      .update(password + user)
      .digest('hex');
    return createHash('md5')
      .update(inner)
      .update(salt)
      .digest('hex');
  }

  /**
   * Send password message
   * @private
   */
  _sendPassword(password) {
    const buf = Buffer.alloc(1 + 4 + password.length + 1);
    buf[0] = FE.PasswordMessage;
    buf.writeUInt32BE(4 + password.length + 1, 1);
    buf.write(password + '\0', 5);
    this.socket.write(buf);
  }

  /**
   * Handle ReadyForQuery message
   * @private
   */
  _handleReadyForQuery(payload) {
    const _txStatus = String.fromCharCode(payload[0]); // 'I', 'T', or 'E'

    if (this.state === 'authenticated' || this.state === 'startup') {
      this.state = 'ready';
      this._resolveConnect();
    } else if (this.state === 'query') {
      this.state = 'ready';
      this._resolveQuery({
        rows: this._rows,
        columns: this._columns,
        command: this._commandTag
      });
    } else if (this.state === 'copyTo') {
      this.state = 'ready';
      this._resolveCopy();
    } else if (this.state === 'copyFrom') {
      this.state = 'ready';
      this._resolveCopy();
    }
  }

  /**
   * Handle RowDescription message
   * @private
   */
  _handleRowDescription(payload) {
    const fieldCount = payload.readUInt16BE(0);
    const columns = [];
    let offset = 2;

    for (let i = 0; i < fieldCount; i++) {
      const nameEnd = payload.indexOf(0, offset);
      const name = payload.toString('utf8', offset, nameEnd);
      offset = nameEnd + 1;

      const _tableOid = payload.readUInt32BE(offset);
      offset += 4;
      const _columnId = payload.readUInt16BE(offset);
      offset += 2;
      const typeOid = payload.readUInt32BE(offset);
      offset += 4;
      const _typeLen = payload.readInt16BE(offset);
      offset += 2;
      const _typeMod = payload.readInt32BE(offset);
      offset += 4;
      const format = payload.readUInt16BE(offset);
      offset += 2;

      columns.push({ name, typeOid, format });
    }

    this._columns = columns;
  }

  /**
   * Handle DataRow message
   * @private
   */
  _handleDataRow(payload) {
    const columnCount = payload.readUInt16BE(0);
    const row = {};
    let offset = 2;

    for (let i = 0; i < columnCount; i++) {
      const valueLen = payload.readInt32BE(offset);
      offset += 4;

      if (valueLen === -1) {
        row[this._columns[i].name] = null;
      } else {
        const value = payload.toString('utf8', offset, offset + valueLen);
        offset += valueLen;
        row[this._columns[i].name] = this._parseValue(value, this._columns[i].typeOid);
      }
    }

    this._rows.push(row);
  }

  /**
   * Parse value based on PostgreSQL type OID
   * @private
   */
  _parseValue(value, typeOid) {
    // Basic type conversion
    switch (typeOid) {
      case 23:   // int4
      case 21:   // int2
      case 20:   // int8
        return parseInt(value, 10);
      case 700:  // float4
      case 701:  // float8
      case 1700: // numeric
        return parseFloat(value);
      case 16:   // bool
        return value === 't' || value === 'true';
      case 1114: // timestamp
      case 1184: // timestamptz
        return new Date(value);
      default:
        return value;
    }
  }

  /**
   * Handle error response
   * @private
   */
  _handleError(payload) {
    const error = this._parseErrorFields(payload);
    const err = new Error(error.message || 'PostgreSQL error');
    err.code = error.code;
    err.detail = error.detail;
    err.severity = error.severity;

    if (this.state === 'startup' || this.state === 'authenticated') {
      this._rejectConnect(err);
    } else if (this.state === 'query') {
      this._rejectQuery(err);
    } else if (this.state === 'copyTo' || this.state === 'copyFrom') {
      this._rejectCopy(err);
    }
  }

  /**
   * Parse error response fields
   * @private
   */
  _parseErrorFields(payload) {
    const fields = {};
    let offset = 0;

    while (offset < payload.length) {
      const fieldType = String.fromCharCode(payload[offset]);
      if (fieldType === '\0') break;
      offset++;

      const valueEnd = payload.indexOf(0, offset);
      const value = payload.toString('utf8', offset, valueEnd);
      offset = valueEnd + 1;

      switch (fieldType) {
        case 'S': fields.severity = value; break;
        case 'C': fields.code = value; break;
        case 'M': fields.message = value; break;
        case 'D': fields.detail = value; break;
        case 'H': fields.hint = value; break;
        case 'P': fields.position = value; break;
      }
    }

    return fields;
  }

  /**
   * Handle CopyOutResponse (COPY TO started)
   * @private
   */
  _handleCopyOutResponse(_payload) {
    this.state = 'copyTo';
    this._copyChunks = [];
    // Format and column info available in _payload but not needed for binary copy
  }

  /**
   * Handle CopyInResponse (COPY FROM ready)
   * @private
   */
  _handleCopyInResponse(_payload) {
    this.state = 'copyFrom';
    // Server is ready to receive COPY data
    if (this._copyCallback) {
      this._copyCallback();
    }
  }

  /**
   * Handle CopyData message (for COPY TO)
   * @private
   */
  _handleCopyData(payload) {
    if (this.state === 'copyTo') {
      this._copyChunks.push(Buffer.from(payload));
    }
  }

  /**
   * Handle connection close
   * @private
   */
  _onClose() {
    this.state = 'disconnected';
    this.socket = null;
  }

  /**
   * Handle socket error
   * @private
   */
  _onError(err) {
    if (this._connectReject) {
      this._connectReject(err);
    } else if (this._queryReject) {
      this._queryReject(err);
    } else if (this._copyReject) {
      this._copyReject(err);
    }
  }

  // Promise resolution helpers
  _resolveConnect() {
    if (this._connectResolve) {
      this._connectResolve();
      this._connectResolve = null;
      this._connectReject = null;
    }
  }

  _rejectConnect(err) {
    if (this._connectReject) {
      this._connectReject(err);
      this._connectResolve = null;
      this._connectReject = null;
    }
  }

  _resolveQuery(result) {
    if (this._queryResolve) {
      this._queryResolve(result);
      this._queryResolve = null;
      this._queryReject = null;
    }
  }

  _rejectQuery(err) {
    if (this._queryReject) {
      this._queryReject(err);
      this._queryResolve = null;
      this._queryReject = null;
    }
  }

  _resolveCopy() {
    if (this._copyResolve) {
      this._copyResolve();
      this._copyResolve = null;
      this._copyReject = null;
    }
  }

  _rejectCopy(err) {
    if (this._copyReject) {
      this._copyReject(err);
      this._copyResolve = null;
      this._copyReject = null;
    }
  }

  /**
   * Execute a simple query
   * @param {string} sql - SQL query
   * @returns {Promise<{rows: Object[], columns: Object[], command: string}>}
   */
  async query(sql) {
    if (this.state !== 'ready') {
      throw new Error(`Cannot query: client is ${this.state}`);
    }

    return new Promise((resolve, reject) => {
      this._queryResolve = resolve;
      this._queryReject = reject;
      this._columns = [];
      this._rows = [];
      this._commandTag = '';
      this.state = 'query';

      // Send Query message
      const buf = Buffer.alloc(1 + 4 + Buffer.byteLength(sql, 'utf8') + 1);
      buf[0] = FE.Query;
      buf.writeUInt32BE(4 + Buffer.byteLength(sql, 'utf8') + 1, 1);
      buf.write(sql + '\0', 5);
      this.socket.write(buf);
    });
  }

  /**
   * Execute COPY TO STDOUT - returns async iterator of binary chunks
   * @param {string} sql - COPY TO query
   * @returns {AsyncGenerator<Buffer>}
   */
  async *copyTo(sql) {
    if (this.state !== 'ready') {
      throw new Error(`Cannot copyTo: client is ${this.state}`);
    }

    // Reset copy state
    this._copyChunks = [];
    this.state = 'copyTo';

    // Send Query message
    const buf = Buffer.alloc(1 + 4 + Buffer.byteLength(sql, 'utf8') + 1);
    buf[0] = FE.Query;
    buf.writeUInt32BE(4 + Buffer.byteLength(sql, 'utf8') + 1, 1);
    buf.write(sql + '\0', 5);
    this.socket.write(buf);

    // Yield chunks as they arrive
    while (this.state === 'copyTo') {
      // Wait for data or state change
      await this._waitForData();

      // Yield accumulated chunks
      while (this._copyChunks.length > 0) {
        yield this._copyChunks.shift();
      }
    }
  }

  /**
   * Wait for more data or state change
   * @private
   */
  _waitForData() {
    return new Promise(resolve => {
      if (this._copyChunks.length > 0 || this.state !== 'copyTo') {
        resolve();
        return;
      }

      // Poll for changes (simple approach)
      const check = () => {
        if (this._copyChunks.length > 0 || this.state !== 'copyTo') {
          resolve();
        } else {
          setTimeout(check, 1);
        }
      };
      setTimeout(check, 1);
    });
  }

  /**
   * Execute COPY FROM STDIN - accepts async iterator of binary chunks
   * @param {string} sql - COPY FROM query
   * @param {AsyncIterable<Buffer>} dataIterator - Iterator yielding data chunks
   * @returns {Promise<void>}
   */
  async copyFrom(sql, dataIterator) {
    if (this.state !== 'ready') {
      throw new Error(`Cannot copyFrom: client is ${this.state}`);
    }

    return new Promise(async (resolve, reject) => {
      this._copyResolve = resolve;
      this._copyReject = reject;

      // Wait for CopyInResponse
      this._copyCallback = async () => {
        try {
          // Send CopyData messages
          for await (const chunk of dataIterator) {
            const msg = Buffer.alloc(1 + 4 + chunk.length);
            msg[0] = FE.CopyData;
            msg.writeUInt32BE(4 + chunk.length, 1);
            chunk.copy(msg, 5);
            this.socket.write(msg);
          }

          // Send CopyDone
          const done = Buffer.alloc(5);
          done[0] = FE.CopyDone;
          done.writeUInt32BE(4, 1);
          this.socket.write(done);
        } catch (err) {
          // Send CopyFail
          const errMsg = err.message || 'Copy failed';
          const fail = Buffer.alloc(1 + 4 + Buffer.byteLength(errMsg, 'utf8') + 1);
          fail[0] = FE.CopyFail;
          fail.writeUInt32BE(4 + Buffer.byteLength(errMsg, 'utf8') + 1, 1);
          fail.write(errMsg + '\0', 5);
          this.socket.write(fail);
          reject(err);
        }

        this._copyCallback = null;
      };

      this.state = 'copyFrom';

      // Send Query message
      const buf = Buffer.alloc(1 + 4 + Buffer.byteLength(sql, 'utf8') + 1);
      buf[0] = FE.Query;
      buf.writeUInt32BE(4 + Buffer.byteLength(sql, 'utf8') + 1, 1);
      buf.write(sql + '\0', 5);
      this.socket.write(buf);
    });
  }

  /**
   * Close the connection gracefully
   */
  close() {
    if (this.socket) {
      // Send Terminate message
      const terminate = Buffer.alloc(5);
      terminate[0] = FE.Terminate;
      terminate.writeUInt32BE(4, 1);
      this.socket.write(terminate);
      this.socket.end();
      this.socket = null;
    }
    this.state = 'disconnected';
  }

  /**
   * Check if client is connected and ready
   */
  get isReady() {
    return this.state === 'ready';
  }
}

/**
 * PostgreSQL Connection Pool
 *
 * Manages a pool of PgWireClient connections.
 *
 * @example
 * const pool = new PgWirePool({ hostname: '127.0.0.1', port: 5432, max: 8 });
 * const client = await pool.connect();
 * const result = await client.query('SELECT 1');
 * pool.release(client);
 * await pool.end();
 */
export class PgWirePool {
  constructor(options = {}) {
    this.options = options;
    this.max = options.max || 10;
    this.available = [];
    this.inUse = new Set();
    this.waiters = [];
    this.closed = false;
  }

  /**
   * Acquire a connection from the pool
   * @returns {Promise<PgWireClient>}
   */
  async connect() {
    if (this.closed) {
      throw new Error('Pool is closed');
    }

    // Return available connection
    if (this.available.length > 0) {
      const client = this.available.pop();
      this.inUse.add(client);
      return client;
    }

    // Create new connection if under limit
    if (this.inUse.size < this.max) {
      const client = new PgWireClient(this.options);
      await client.connect();
      this.inUse.add(client);
      return client;
    }

    // Wait for available connection
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Release a connection back to the pool
   * @param {PgWireClient} client
   */
  release(client) {
    if (!this.inUse.has(client)) {
      return;
    }

    this.inUse.delete(client);

    // Check for waiting requests
    if (this.waiters.length > 0 && client.isReady) {
      const waiter = this.waiters.shift();
      this.inUse.add(client);
      waiter.resolve(client);
      return;
    }

    // Return to pool if still usable
    if (client.isReady && !this.closed) {
      this.available.push(client);
    } else {
      client.close();
    }
  }

  /**
   * Execute a query using a pooled connection
   * @param {string} sql - SQL query
   * @returns {Promise<{rows: Object[], columns: Object[], command: string}>}
   */
  async query(sql) {
    const client = await this.connect();
    try {
      return await client.query(sql);
    } finally {
      this.release(client);
    }
  }

  /**
   * Close all connections and the pool
   */
  async end() {
    this.closed = true;

    // Reject waiting requests
    for (const waiter of this.waiters) {
      waiter.reject(new Error('Pool is closing'));
    }
    this.waiters = [];

    // Close all connections
    for (const client of [...this.available, ...this.inUse]) {
      client.close();
    }
    this.available = [];
    this.inUse.clear();
  }

  /**
   * Get pool statistics
   */
  get stats() {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      waiting: this.waiters.length,
      max: this.max
    };
  }
}

export { FE, BE, AUTH };
