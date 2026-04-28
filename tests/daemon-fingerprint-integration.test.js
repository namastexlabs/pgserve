/**
 * Daemon × fingerprint integration test (Group 3, deliverable 2).
 *
 * Verifies that PgserveDaemon.handleSocketOpen calls handleControlAccept on
 * every accept, producing a `connection_routed` audit entry whose fingerprint
 * is the documented 12-hex blob.
 *
 * Boots a real daemon (with isolated controlSocketDir + auditLogFile), dials
 * the control socket via Bun.connect, and tails the audit log.
 */

import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PgserveDaemon,
  resolveControlSocketPath,
  resolvePidLockPath,
} from '../src/daemon.js';
import { createLogger } from '../src/logger.js';
import { AUDIT_EVENTS, configureAudit } from '../src/audit.js';

function silentLogger() {
  return createLogger({ level: 'warn' });
}

function makeIsolated(tag) {
  const dir = path.join(os.tmpdir(), `pgserve-daemon-fp-${tag}-${process.pid}-${Date.now()}`);
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

describe('Group 3 — daemon emits connection_routed on accept', () => {
  test('handleSocketOpen derives fingerprint and audits connection_routed', async () => {
    const dir = makeIsolated('routed');
    const auditLogFile = path.join(dir, 'audit.log');

    const daemon = new PgserveDaemon({
      controlSocketDir: dir,
      controlSocketPath: resolveControlSocketPath(dir),
      pidLockPath: resolvePidLockPath(dir),
      pgPort: 16100,
      auditLogFile,
      auditTarget: 'file',
      logger: silentLogger(),
    });
    await daemon.start();

    try {
      // Dial the control socket. We don't need to push a real PG startup
      // message — the accept hook fires the moment the connection opens,
      // before any handshake bytes are needed.
      const acceptedFingerprint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for accept')), 2000);
        daemon.once('accept', ({ fingerprint }) => {
          clearTimeout(timer);
          resolve(fingerprint);
        });
        Bun.connect({
          unix: daemon.controlSocketPath,
          socket: {
            open(s) { s.end(); },
            data() {},
            close() {},
            error(_s, err) { clearTimeout(timer); reject(err); },
          },
        }).catch((err) => { clearTimeout(timer); reject(err); });
      });

      expect(acceptedFingerprint).toBeDefined();
      expect(acceptedFingerprint.fingerprint).toMatch(/^[0-9a-f]{12}$/);

      // Allow the audit appendFileSync to flush. Poll briefly.
      const deadline = Date.now() + 1000;
      let entries = [];
      while (Date.now() < deadline) {
        entries = readAuditLines(auditLogFile);
        if (entries.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(entries.length).toBeGreaterThan(0);
      const routed = entries.find((e) => e.event === AUDIT_EVENTS.CONNECTION_ROUTED);
      expect(routed).toBeDefined();
      expect(routed.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(routed.fingerprint).toBe(acceptedFingerprint.fingerprint);
      expect(routed.peer_uid).toBe(process.getuid());
      expect(typeof routed.peer_pid).toBe('number');
      expect(['package', 'script']).toContain(routed.mode);
    } finally {
      await daemon.stop();
      // Reset audit module's mutable defaults so other tests aren't affected.
      configureAudit({
        logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
        target: process.env.PGSERVE_AUDIT_TARGET || 'file',
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
