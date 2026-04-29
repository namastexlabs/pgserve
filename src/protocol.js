/**
 * PostgreSQL Wire Protocol Parser (Performance Optimized)
 *
 * Extracts database name from PostgreSQL startup message
 * https://www.postgresql.org/docs/current/protocol-message-formats.html
 *
 * Optimizations:
 * - Fast path for database extraction (skip full parsing if possible)
 * - Minimize string allocations
 * - Use Buffer.indexOf for faster null-byte search
 */

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;    // PostgreSQL SSL negotiation request
const GSSAPI_REQUEST_CODE = 80877104; // PostgreSQL GSSAPI encryption request
const CANCEL_REQUEST_CODE = 80877102; // PostgreSQL cancel request

/**
 * Parse PostgreSQL startup message to extract connection parameters
 * OPTIMIZED: Fast path for database extraction
 *
 * @param {Buffer} data - Raw startup message data
 * @param {boolean} [fastPath=true] - Use fast path (only extract database)
 * @returns {Object} Parsed parameters (user, database, application_name, etc.)
 */
export function parseStartupMessage(data, fastPath = true) {
  const length = data.readInt32BE(0);
  const version = data.readInt32BE(4);

  // Verify protocol version (3.0 = 196608)
  if (version !== PROTOCOL_VERSION_3) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  // Fast path: only extract database name (most common case)
  if (fastPath) {
    const dbName = extractDatabaseFast(data, 8, length);
    if (dbName) {
      return { database: dbName };
    }
    // Fallback to full parse if fast path failed
  }

  // Full parse (slower but complete)
  const params = {};
  let offset = 8;

  while (offset < length - 1) {
    // Find next null byte (key end)
    const keyEnd = data.indexOf(0, offset);
    if (keyEnd === -1 || keyEnd >= length) break;

    // Extract key (avoid toString for common keys)
    const key = data.toString('utf8', offset, keyEnd);
    offset = keyEnd + 1;

    // Find next null byte (value end)
    const valueEnd = data.indexOf(0, offset);
    if (valueEnd === -1 || valueEnd >= length) break;

    // Extract value
    const value = data.toString('utf8', offset, valueEnd);
    offset = valueEnd + 1;

    params[key] = value;
  }

  return params;
}

/**
 * Fast path: Extract database name without parsing all parameters
 * PERFORMANCE: ~3x faster than full parse
 *
 * @param {Buffer} data - Startup message buffer
 * @param {number} offset - Start offset (after header)
 * @param {number} length - Total message length
 * @returns {string|null} Database name or null
 */
function extractDatabaseFast(data, offset, length) {
  // Search for "database\0" key
  while (offset < length - 1) {
    // Find next null byte
    const nullPos = data.indexOf(0, offset);
    if (nullPos === -1 || nullPos >= length) break;

    const keyLength = nullPos - offset;

    // Check if this is the "database" key (compare bytes directly)
    if (keyLength === 8 && data[offset] === 0x64 /* 'd' */) {
      // Quick byte comparison for "database"
      if (
        data[offset + 1] === 0x61 && // 'a'
        data[offset + 2] === 0x74 && // 't'
        data[offset + 3] === 0x61 && // 'a'
        data[offset + 4] === 0x62 && // 'b'
        data[offset + 5] === 0x61 && // 'a'
        data[offset + 6] === 0x73 && // 's'
        data[offset + 7] === 0x65 // 'e'
      ) {
        // Found "database" key, extract value
        offset = nullPos + 1;
        const valueEnd = data.indexOf(0, offset);
        if (valueEnd === -1 || valueEnd >= length) return null;

        return data.toString('utf8', offset, valueEnd);
      }
    }

    // Skip to next key-value pair
    offset = nullPos + 1;
    const valueEnd = data.indexOf(0, offset);
    if (valueEnd === -1) break;
    offset = valueEnd + 1;
  }

  return null;
}

/**
 * Extract database name from startup message
 *
 * @param {Buffer} data - Raw startup message data
 * @returns {string} Database name (defaults to 'postgres')
 */
export function extractDatabaseName(data) {
  try {
    const params = parseStartupMessage(data);
    return params.database || 'postgres';
  } catch (error) {
    console.warn('Failed to parse startup message:', error.message);
    return 'postgres'; // Fallback to default
  }
}

/**
 * Extract `application_name` from a startup message buffer. Returns null when
 * absent or when the buffer is malformed (callers fall back to no-auth).
 *
 * @param {Buffer} data
 * @returns {string|null}
 */
export function extractApplicationName(data) {
  try {
    const params = parseStartupMessage(data, /* fastPath */ false);
    return typeof params.application_name === 'string' ? params.application_name : null;
  } catch {
    return null;
  }
}

/**
 * Return a new startup-message buffer with the `database` parameter replaced
 * by `newDbName`. All other parameters (and their order) are preserved by
 * default; pass `dropParams: ['application_name', ...]` to strip noisy
 * fields the daemon would rather not forward to PG verbatim. The 4-byte
 * length prefix at the start of the buffer is recomputed.
 *
 * Group 6 uses this on TCP-authenticated connections so a peer that presents
 * a token for fingerprint X is forced into fingerprint X's database, even
 * if the libpq client requested a different one.
 *
 * @param {Buffer} data — original startup message
 * @param {string} newDbName
 * @param {{dropParams?: string[]}} [opts]
 * @returns {Buffer}
 */
export function rewriteDatabaseName(data, newDbName, opts = {}) {
  if (!Buffer.isBuffer(data)) throw new Error('rewriteDatabaseName: buffer required');
  if (typeof newDbName !== 'string' || newDbName.length === 0) {
    throw new Error('rewriteDatabaseName: non-empty newDbName required');
  }
  const length = data.readInt32BE(0);
  const version = data.readInt32BE(4);
  const drop = new Set(opts.dropParams || []);

  // Walk parameters; build a list of (key, value) pairs replacing 'database'.
  const pairs = [];
  let offset = 8;
  let sawDatabase = false;
  while (offset < length - 1) {
    const keyEnd = data.indexOf(0, offset);
    if (keyEnd === -1 || keyEnd >= length) break;
    const key = data.toString('utf8', offset, keyEnd);
    offset = keyEnd + 1;
    const valueEnd = data.indexOf(0, offset);
    if (valueEnd === -1 || valueEnd >= length) break;
    const value = data.toString('utf8', offset, valueEnd);
    offset = valueEnd + 1;
    if (drop.has(key)) continue;
    if (key === 'database') {
      pairs.push(['database', newDbName]);
      sawDatabase = true;
    } else {
      pairs.push([key, value]);
    }
  }
  if (!sawDatabase) pairs.push(['database', newDbName]);

  // Compute new buffer size: 4 (length) + 4 (version) + sum(key+1 + value+1) + 1 (terminator).
  let bodyLen = 0;
  for (const [k, v] of pairs) {
    bodyLen += Buffer.byteLength(k, 'utf8') + 1 + Buffer.byteLength(v, 'utf8') + 1;
  }
  const total = 4 + 4 + bodyLen + 1;
  const out = Buffer.alloc(total);
  out.writeInt32BE(total, 0);
  out.writeInt32BE(version, 4);
  let cur = 8;
  for (const [k, v] of pairs) {
    cur += out.write(k, cur, 'utf8');
    out[cur++] = 0;
    cur += out.write(v, cur, 'utf8');
    out[cur++] = 0;
  }
  out[cur++] = 0; // final terminator
  return out;
}

// Pre-allocated buffer pool for startup message parsing (avoids allocation per connection)
const STARTUP_BUFFER_SIZE = 8192; // Max startup message is typically < 1KB
const bufferPool = [];
const MAX_POOL_SIZE = 100;

function acquireBuffer() {
  return bufferPool.pop() || Buffer.allocUnsafe(STARTUP_BUFFER_SIZE);
}

function releaseBuffer(buf) {
  if (bufferPool.length < MAX_POOL_SIZE) {
    bufferPool.push(buf);
  }
}

/**
 * Read startup message from socket and buffer it
 * OPTIMIZED: Uses pre-allocated buffer pool to avoid allocation per connection
 *
 * @param {net.Socket} socket - TCP socket
 * @returns {Promise<{message: Buffer, allData: Buffer}>} Startup message and all buffered data
 */
export async function readStartupMessage(socket) {
  return new Promise((resolve, reject) => {
    const buffer = acquireBuffer();
    let offset = 0;
    let expectedLength = null;
    let resolved = false;

    const onData = (chunk) => {
      if (resolved) return;

      // Copy chunk into pre-allocated buffer (avoids Buffer.concat allocation)
      const copyLen = Math.min(chunk.length, STARTUP_BUFFER_SIZE - offset);
      chunk.copy(buffer, offset, 0, copyLen);
      offset += copyLen;

      // Read expected length from first 4 bytes
      if (expectedLength === null && offset >= 4) {
        expectedLength = buffer.readInt32BE(0);
      }

      // Check if we have full message
      if (expectedLength !== null && offset >= expectedLength) {
        resolved = true;
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);

        // Create result buffers (need to copy since we're reusing pool buffer)
        const message = Buffer.from(buffer.subarray(0, expectedLength));
        const allData = Buffer.from(buffer.subarray(0, offset));
        releaseBuffer(buffer);
        resolve({ message, allData });
      }
    };

    const onError = (error) => {
      if (resolved) return;
      resolved = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      releaseBuffer(buffer);
      reject(error);
    };

    socket.on('data', onData);
    socket.on('error', onError);

    // Resume socket AFTER listeners are set up (prevents race condition)
    socket.resume();

    // Timeout after 2 seconds (reduced from 5s for faster probe connection handling)
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      releaseBuffer(buffer);
      reject(new Error('Timeout reading startup message'));
    }, 2000);
  });
}

/**
 * Extract database name from socket connection (with SSL negotiation support)
 *
 * @param {net.Socket} socket - TCP socket
 * @returns {Promise<{dbName: string, buffered: Buffer}>} Database name and buffered data
 */
// Unused but kept for potential future use
async function _extractDatabaseNameFromSocket(socket) {
  let { message, allData } = await readStartupMessage(socket);

  // Check if this is a protocol negotiation request (SSL, GSSAPI, Cancel)
  if (message.length >= 8) {
    const version = message.readInt32BE(4);

    if (version === SSL_REQUEST_CODE) {
      // Respond with 'N' (no SSL support)
      socket.write(Buffer.from('N'));

      // Read the actual startup message
      const result = await readStartupMessage(socket);
      message = result.message;
      allData = result.allData;
    } else if (version === GSSAPI_REQUEST_CODE) {
      // Respond with 'N' (no GSSAPI support)
      socket.write(Buffer.from('N'));

      // Read the actual startup message
      const result = await readStartupMessage(socket);
      message = result.message;
      allData = result.allData;
    } else if (version === CANCEL_REQUEST_CODE) {
      // Cancel request - query cancellation not implemented
      // Just close gracefully (cancel requests don't expect a response)
      throw new Error('Cancel request received (not supported)');
    }
  }

  const dbName = extractDatabaseName(message);
  return { dbName, buffered: allData };
}
