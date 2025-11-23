/**
 * PostgreSQL Wire Protocol Parser
 *
 * Extracts database name from PostgreSQL startup message
 * https://www.postgresql.org/docs/current/protocol-message-formats.html
 */

/**
 * Parse PostgreSQL startup message to extract connection parameters
 *
 * @param {Buffer} data - Raw startup message data
 * @returns {Object} Parsed parameters (user, database, application_name, etc.)
 */
export function parseStartupMessage(data) {
  const params = {};

  // Startup message format:
  // [4 bytes] Length (including self)
  // [4 bytes] Protocol version (196608 for v3.0)
  // [N bytes] Parameters (null-terminated key-value pairs)
  // [1 byte]  Terminator (0x00)

  const length = data.readInt32BE(0);
  const version = data.readInt32BE(4);

  // Verify protocol version (3.0 = 196608)
  if (version !== 196608) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  let offset = 8; // Skip length + version

  // Read key-value pairs until terminator
  while (offset < length - 1) {
    // Read key (null-terminated string)
    let keyEnd = offset;
    while (keyEnd < data.length && data[keyEnd] !== 0) {
      keyEnd++;
    }

    if (keyEnd >= data.length) {
      break; // Malformed message
    }

    const key = data.toString('utf8', offset, keyEnd);
    offset = keyEnd + 1; // Skip null terminator

    // Read value (null-terminated string)
    let valueEnd = offset;
    while (valueEnd < data.length && data[valueEnd] !== 0) {
      valueEnd++;
    }

    if (valueEnd >= data.length) {
      break; // Malformed message
    }

    const value = data.toString('utf8', offset, valueEnd);
    offset = valueEnd + 1; // Skip null terminator

    params[key] = value;
  }

  return params;
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
 * Read startup message from socket and buffer it
 *
 * @param {net.Socket} socket - TCP socket
 * @returns {Promise<{message: Buffer, allData: Buffer}>} Startup message and all buffered data
 */
export async function readStartupMessage(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expectedLength = null;
    let resolved = false;

    const onData = (chunk) => {
      if (resolved) return;

      buffer = Buffer.concat([buffer, chunk]);

      // Read expected length from first 4 bytes
      if (expectedLength === null && buffer.length >= 4) {
        expectedLength = buffer.readInt32BE(0);
      }

      // Check if we have full message
      if (expectedLength !== null && buffer.length >= expectedLength) {
        resolved = true;
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);

        const message = buffer.slice(0, expectedLength);
        resolve({ message, allData: buffer });
      }
    };

    const onError = (error) => {
      if (resolved) return;
      resolved = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(error);
    };

    socket.on('data', onData);
    socket.on('error', onError);

    // Timeout after 5 seconds
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(new Error('Timeout reading startup message'));
    }, 5000);
  });
}

/**
 * Extract database name from socket connection
 *
 * @param {net.Socket} socket - TCP socket
 * @returns {Promise<{dbName: string, buffered: Buffer}>} Database name and buffered data
 */
export async function extractDatabaseNameFromSocket(socket) {
  const { message, allData } = await readStartupMessage(socket);
  const dbName = extractDatabaseName(message);
  return { dbName, buffered: allData };
}
