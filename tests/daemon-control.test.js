import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  PgserveDaemon,
  resolveControlSocketPath,
  resolvePidLockPath,
} from '../src/daemon.js';
import { createLogger } from '../src/logger.js';

const SSL_REQUEST_CODE = 80877103;
const PROTOCOL_VERSION_3 = 196608;

function silentLogger() {
  return createLogger({ level: process.env.PGSERVE_TEST_LOG || 'warn' });
}

function makeIsolated(tag) {
  const dir = path.join('/tmp', `pgs-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sslRequest() {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(8, 0);
  buf.writeUInt32BE(SSL_REQUEST_CODE, 4);
  return buf;
}

function startupMessage({ user = 'postgres', database = 'postgres' } = {}) {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0client_encoding\0UTF8\0\0`);
  const buf = Buffer.alloc(8 + params.length);
  buf.writeUInt32BE(buf.length, 0);
  buf.writeUInt32BE(PROTOCOL_VERSION_3, 4);
  params.copy(buf, 8);
  return buf;
}

function passwordMessage(password = 'postgres') {
  const body = Buffer.from(`${password}\0`);
  const buf = Buffer.alloc(1 + 4 + body.length);
  buf.write('p', 0);
  buf.writeUInt32BE(4 + body.length, 1);
  body.copy(buf, 5);
  return buf;
}

async function connectWithCoalescedStartup(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let sawSslReject = false;
    let sawAuthOk = false;

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for ReadyForQuery after coalesced startup'));
    }, 5000);
    timer.unref();

    const done = (err, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    const pump = () => {
      if (!sawSslReject) {
        if (buffer.length < 1) return;
        if (buffer[0] !== 78) {
          done(new Error(`expected SSL reject byte N, got ${buffer[0]}`));
          return;
        }
        sawSslReject = true;
        buffer = buffer.subarray(1);
      }

      while (buffer.length >= 5) {
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 1 + length) return;

        const payload = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);

        if (type === 'R') {
          const authCode = payload.readUInt32BE(0);
          if (authCode === 3) socket.write(passwordMessage());
          if (authCode === 0) sawAuthOk = true;
        } else if (type === 'E') {
          done(new Error(`postgres error response: ${payload.toString('utf8')}`));
          return;
        } else if (type === 'Z') {
          done(null, { sawSslReject, sawAuthOk });
          return;
        }
      }
    };

    socket.on('connect', () => {
      socket.write(Buffer.concat([sslRequest(), startupMessage()]));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', done);
  });
}

describe('daemon Unix control protocol', () => {
  test('processes startup already buffered behind SSLRequest', async () => {
    const dir = makeIsolated('coalesced');
    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: await freeTcpPort(),
      logger: silentLogger(),
    });

    await daemon.start();
    try {
      const result = await connectWithCoalescedStartup(resolveControlSocketPath(dir));
      expect(result).toEqual({ sawSslReject: true, sawAuthOk: true });
    } finally {
      await daemon.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('processes startup after the admin client idles out', async () => {
    const dir = makeIsolated('admin-idle');
    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: await freeTcpPort(),
      adminIdleTimeout: 1,
      adminLookupTimeoutMs: 1000,
      logger: silentLogger(),
    });

    await daemon.start();
    try {
      await connectWithCoalescedStartup(resolveControlSocketPath(dir));
      await Bun.sleep(1500);
      const result = await connectWithCoalescedStartup(resolveControlSocketPath(dir));
      expect(result).toEqual({ sawSslReject: true, sawAuthOk: true });
    } finally {
      await daemon.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
