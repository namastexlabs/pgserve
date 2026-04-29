/**
 * Group 6 — opt-in TCP listener + bearer-token auth.
 *
 * Coverage matches the wish acceptance criteria:
 *   • TCP connect without token denied (audit `tcp_token_denied`).
 *   • TCP connect with correct token reaches the right fingerprint's DB
 *     (audit `tcp_token_used`, libpq round-trips through the proxy).
 *   • Token revoke via revokeAllowedToken works (denies subsequent connects).
 *   • Without `--listen`, no TCP port bound (lifecycle assertion).
 */

import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import pg from 'pg';

import {
  PgserveDaemon,
  resolveControlSocketPath,
  resolvePidLockPath,
  normalizeTcpListens,
} from '../src/daemon.js';
import { createLogger } from '../src/logger.js';
import { configureAudit, AUDIT_EVENTS } from '../src/audit.js';
import { recordDbCreated, addAllowedToken, revokeAllowedToken } from '../src/control-db.js';
import { hashToken, parseTcpAuth } from '../src/tokens.js';

const { Client } = pg;

function silentLogger() {
  return createLogger({ level: process.env.PGSERVE_TEST_LOG || 'warn' });
}

function makeIsolated(tag) {
  const dir = path.join(os.tmpdir(), `pgserve-tcp-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readAuditLines(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function pollForAudit(logFile, predicate, deadlineMs = 1500) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const lines = readAuditLines(logFile);
    const hit = lines.find(predicate);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
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

function findAuditEvent(logFile, event) {
  return readAuditLines(logFile).filter((e) => e.event === event);
}

// --------------------------------------------------------------------------
// Pure-input tests: parseTcpAuth + normalizeTcpListens — no daemon required.
// --------------------------------------------------------------------------

describe('Group 6 — token + listen parsers', () => {
  test('parseTcpAuth accepts ?fingerprint=&token= form', () => {
    const out = parseTcpAuth('?fingerprint=abc123def456&token=secret');
    expect(out).toEqual({ fingerprint: 'abc123def456', token: 'secret' });
  });

  test('parseTcpAuth accepts the prefix-less form', () => {
    const out = parseTcpAuth('fingerprint=abc123def456&token=secret');
    expect(out).toEqual({ fingerprint: 'abc123def456', token: 'secret' });
  });

  test('parseTcpAuth rejects malformed inputs', () => {
    expect(parseTcpAuth(null)).toBeNull();
    expect(parseTcpAuth('')).toBeNull();
    expect(parseTcpAuth('fingerprint=abc&token=secret')).toBeNull();   // not 12 hex
    expect(parseTcpAuth('fingerprint=abc123def456')).toBeNull();       // missing token
    expect(parseTcpAuth('token=secret')).toBeNull();                   // missing fingerprint
    expect(parseTcpAuth('fingerprint=ZZZZZZZZZZZZ&token=x')).toBeNull(); // non-hex
  });

  test('normalizeTcpListens parses every documented form', () => {
    expect(normalizeTcpListens(undefined)).toEqual([]);
    expect(normalizeTcpListens('5432')).toEqual([{ host: '0.0.0.0', port: 5432 }]);
    expect(normalizeTcpListens(':5432')).toEqual([{ host: '0.0.0.0', port: 5432 }]);
    expect(normalizeTcpListens('127.0.0.1:5432')).toEqual([{ host: '127.0.0.1', port: 5432 }]);
    expect(normalizeTcpListens(['127.0.0.1:6000', ':6001'])).toEqual([
      { host: '127.0.0.1', port: 6000 },
      { host: '0.0.0.0', port: 6001 },
    ]);
  });

  test('normalizeTcpListens rejects invalid ports', () => {
    expect(() => normalizeTcpListens('garbage')).toThrow();
    expect(() => normalizeTcpListens(':99999')).toThrow();
    expect(() => normalizeTcpListens(':0')).toThrow();
  });
});

// --------------------------------------------------------------------------
// End-to-end: daemon with --listen, real TCP psql-style connect.
// --------------------------------------------------------------------------

describe('Group 6 — daemon TCP path', () => {
  test('without --listen no TCP port is bound', async () => {
    const dir = makeIsolated('no-listen');
    const auditLogFile = path.join(dir, 'audit.log');
    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16200,
      auditLogFile,
      auditTarget: 'file',
      logger: silentLogger(),
    });
    await daemon.start();
    try {
      expect(daemon.tcpServers.length).toBe(0);
      expect(daemon.tcpListens).toEqual([]);
    } finally {
      await daemon.stop();
      configureAudit({
        logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
        target: process.env.PGSERVE_AUDIT_TARGET || 'file',
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TCP connect without token is denied + audited', async () => {
    const dir = makeIsolated('deny');
    const auditLogFile = path.join(dir, 'audit.log');
    const tcpPort = await freeTcpPort();
    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16210,
      auditLogFile,
      auditTarget: 'file',
      tcpListens: [`127.0.0.1:${tcpPort}`],
      logger: silentLogger(),
    });
    await daemon.start();
    try {
      expect(daemon.tcpServers.length).toBe(1);

      // Spin up a libpq client without an application_name token. The
      // daemon must close the connection before the handshake completes.
      const client = new Client({
        host: '127.0.0.1',
        port: tcpPort,
        database: 'postgres',
        user: 'postgres',
        password: 'postgres',
        connectionTimeoutMillis: 1000,
      });

      let captured;
      try {
        await client.connect();
        await client.query('SELECT 1');
      } catch (err) {
        captured = err;
      } finally {
        try { await client.end(); } catch { /* swallow */ }
      }
      expect(captured).toBeDefined();

      const denied = await pollForAudit(
        auditLogFile,
        (e) => e.event === AUDIT_EVENTS.TCP_TOKEN_DENIED,
      );
      expect(denied).not.toBeNull();
      expect(denied.reason).toBeDefined();
    } finally {
      await daemon.stop();
      configureAudit({
        logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
        target: process.env.PGSERVE_AUDIT_TARGET || 'file',
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TCP connect with valid token reaches the fingerprint DB', async () => {
    const dir = makeIsolated('allow');
    const auditLogFile = path.join(dir, 'audit.log');
    const tcpPort = await freeTcpPort();
    const fingerprint = 'a1b2c3d4e5f6';
    const cleartext = 'super-secret-bearer-token';
    const dbName = 'app_tcptest_a1b2c3d4e5f6';

    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16220,
      auditLogFile,
      auditTarget: 'file',
      tcpListens: [`127.0.0.1:${tcpPort}`],
      logger: silentLogger(),
    });
    await daemon.start();

    try {
      // Pre-seed pgserve_meta with a row for the fingerprint, then issue
      // a token. Real production uses the issue-token CLI; the test goes
      // through the same control-db path.
      await daemon.pgManager.createDatabase(dbName);
      await recordDbCreated(daemon._adminClient, {
        databaseName: dbName,
        fingerprint,
        peerUid: process.getuid(),
      });
      await addAllowedToken(daemon._adminClient, {
        fingerprint,
        tokenId: 'token-id-1',
        tokenHash: hashToken(cleartext),
      });

      // Connect via TCP with the token in application_name. Note: the
      // libpq client requests `database: 'postgres'` — daemon must
      // rewrite to the fingerprint's `dbName`.
      const client = new Client({
        host: '127.0.0.1',
        port: tcpPort,
        database: 'postgres',
        user: 'postgres',
        password: 'postgres',
        application_name: `?fingerprint=${fingerprint}&token=${cleartext}`,
        connectionTimeoutMillis: 2000,
      });
      await client.connect();
      try {
        const r = await client.query('SELECT current_database() AS db');
        expect(r.rows[0].db).toBe(dbName);
      } finally {
        await client.end();
      }

      const used = await pollForAudit(
        auditLogFile,
        (e) => e.event === AUDIT_EVENTS.TCP_TOKEN_USED,
      );
      expect(used).not.toBeNull();
      expect(used.fingerprint).toBe(fingerprint);
      expect(used.token_id).toBe('token-id-1');
      expect(used.database).toBe(dbName);
    } finally {
      await daemon.stop();
      configureAudit({
        logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
        target: process.env.PGSERVE_AUDIT_TARGET || 'file',
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('revoked token is denied on subsequent connects', async () => {
    const dir = makeIsolated('revoke');
    const auditLogFile = path.join(dir, 'audit.log');
    const tcpPort = await freeTcpPort();
    const fingerprint = 'feedfacecafe';
    const cleartext = 'rotate-me';
    const dbName = 'app_rev_feedfacecafe';

    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16230,
      auditLogFile,
      auditTarget: 'file',
      tcpListens: [`127.0.0.1:${tcpPort}`],
      logger: silentLogger(),
    });
    await daemon.start();

    try {
      await daemon.pgManager.createDatabase(dbName);
      await recordDbCreated(daemon._adminClient, {
        databaseName: dbName,
        fingerprint,
        peerUid: process.getuid(),
      });
      await addAllowedToken(daemon._adminClient, {
        fingerprint,
        tokenId: 'rev-token-1',
        tokenHash: hashToken(cleartext),
      });

      // Sanity: token works pre-revoke.
      const c1 = new Client({
        host: '127.0.0.1',
        port: tcpPort,
        database: 'postgres',
        user: 'postgres',
        password: 'postgres',
        application_name: `?fingerprint=${fingerprint}&token=${cleartext}`,
        connectionTimeoutMillis: 2000,
      });
      await c1.connect();
      await c1.query('SELECT 1');
      await c1.end();

      // Revoke the token; subsequent connect must fail and audit deny.
      const auditCountBefore = findAuditEvent(auditLogFile, AUDIT_EVENTS.TCP_TOKEN_DENIED).length;
      const affected = await revokeAllowedToken(daemon._adminClient, 'rev-token-1');
      expect(affected).toBe(1);

      const c2 = new Client({
        host: '127.0.0.1',
        port: tcpPort,
        database: 'postgres',
        user: 'postgres',
        password: 'postgres',
        application_name: `?fingerprint=${fingerprint}&token=${cleartext}`,
        connectionTimeoutMillis: 1000,
      });
      let captured;
      try {
        await c2.connect();
      } catch (err) {
        captured = err;
      } finally {
        try { await c2.end(); } catch { /* swallow */ }
      }
      expect(captured).toBeDefined();

      const deadline = Date.now() + 1500;
      let auditCountAfter = auditCountBefore;
      while (Date.now() < deadline) {
        auditCountAfter = findAuditEvent(auditLogFile, AUDIT_EVENTS.TCP_TOKEN_DENIED).length;
        if (auditCountAfter > auditCountBefore) break;
        await new Promise(r => setTimeout(r, 25));
      }
      expect(auditCountAfter).toBeGreaterThan(auditCountBefore);
    } finally {
      await daemon.stop();
      configureAudit({
        logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
        target: process.env.PGSERVE_AUDIT_TARGET || 'file',
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
