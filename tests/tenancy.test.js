/**
 * Group 4 — database-per-fingerprint + enforcement + kill switch.
 *
 * Boots a real pgserve daemon with isolated control socket + audit log,
 * stubs SO_PEERCRED to return synthetic creds, and overrides the
 * fingerprint-derivation cwd per-accept so a single test process can
 * masquerade as several different "projects" connecting to the daemon.
 *
 * Coverage (mirrors WISH §Group 4 acceptance bullets):
 *   1. Two peers with different fingerprints get different DBs
 *   2. Same peer reconnecting reaches its existing DB
 *   3. Cross-fingerprint connection denied with SQLSTATE 28P01
 *   4. Kill-switch env: cross-fingerprint succeeds + audit event emitted
 *   5. Sanitizer: name "@scope/foo bar" → "_scope_foo_bar"
 *
 * Plus unit tests on `sanitizeName` and `resolveTenantDatabaseName` and a
 * boot-time deprecation warning check.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';

import {
  PgserveDaemon,
  resolveControlSocketPath,
  resolvePidLockPath,
  resolveLibpqCompatPath,
} from '../src/daemon.js';
import { _setPeerCredImpl, initFingerprintFfi } from '../src/fingerprint.js';
import { configureAudit, AUDIT_EVENTS } from '../src/audit.js';
import {
  sanitizeName,
  resolveTenantDatabaseName,
  KILL_SWITCH_ENV,
} from '../src/tenancy.js';
import { createLogger } from '../src/logger.js';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('sanitizeName', () => {
  test('collapses non-[a-z0-9] runs to a single underscore', () => {
    expect(sanitizeName('hello-world')).toBe('hello_world');
    expect(sanitizeName('hello---world')).toBe('hello_world');
    expect(sanitizeName('a..b..c')).toBe('a_b_c');
  });

  test('lowercases', () => {
    expect(sanitizeName('UPPER-CASE')).toBe('upper_case');
    expect(sanitizeName('MixedCase')).toBe('mixedcase');
  });

  test('preserves alphanumerics', () => {
    expect(sanitizeName('foo123')).toBe('foo123');
    expect(sanitizeName('1to1')).toBe('1to1');
  });

  test('truncates to 30 chars', () => {
    const long = 'a'.repeat(50);
    expect(sanitizeName(long).length).toBe(30);
  });

  test('handles the wish-spec example', () => {
    expect(sanitizeName('@scope/foo bar')).toBe('_scope_foo_bar');
  });

  test('falls back to "anon" for empty or pure-non-alphanumeric input', () => {
    expect(sanitizeName('')).toBe('anon');
    expect(sanitizeName(null)).toBe('anon');
    expect(sanitizeName(undefined)).toBe('anon');
    expect(sanitizeName('@@@')).toBe('anon');
  });
});

describe('resolveTenantDatabaseName', () => {
  test('builds canonical app_<sanitized>_<fingerprint>', () => {
    expect(resolveTenantDatabaseName({ name: 'demo', fingerprint: 'abcdef012345' }))
      .toBe('app_demo_abcdef012345');
  });

  test('applies sanitization', () => {
    expect(resolveTenantDatabaseName({ name: '@scope/foo bar', fingerprint: 'abcdef012345' }))
      .toBe('app__scope_foo_bar_abcdef012345');
  });

  test('rejects malformed fingerprints', () => {
    expect(() => resolveTenantDatabaseName({ name: 'x', fingerprint: 'TOO-SHORT' }))
      .toThrow(/12 hex chars/);
    expect(() => resolveTenantDatabaseName({ name: 'x', fingerprint: 'GHIJKL012345' }))
      .toThrow(/12 hex chars/);
  });

  test('result fits in PG identifier limit (≤63 chars)', () => {
    const longName = 'a'.repeat(80);
    const ident = resolveTenantDatabaseName({ name: longName, fingerprint: 'abcdef012345' });
    expect(ident.length).toBeLessThanOrEqual(63);
  });
});

// ---------------------------------------------------------------------------
// Daemon integration tests
//
// One daemon shared across the integration suite — PG startup is slow and
// the tests are independent at the pgserve_meta level (each clears its
// state). Per-accept fingerprint behaviour is driven by an override queue
// the test pushes into before each connect.
// ---------------------------------------------------------------------------

describe('daemon tenancy enforcement', () => {
  let daemon;
  let scratch;
  let controlSocketDir;
  let auditFile;
  let overridesQueue;
  let savedAuditDefaults;

  beforeAll(async () => {
    await initFingerprintFfi();
    // Stub peer creds: every accept on the test daemon's control socket
    // appears to come from this process. The real creds matter only for
    // uid (used in fingerprint hashing); pid is ignored once we override
    // cwd via `_fingerprintAcceptOpts`.
    _setPeerCredImpl(() => ({
      pid: process.pid,
      uid: process.getuid(),
      gid: process.getgid(),
    }));

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-tenancy-test-'));
    controlSocketDir = path.join(scratch, 'sock');
    fs.mkdirSync(controlSocketDir, { recursive: true });
    auditFile = path.join(scratch, 'audit.log');

    // Save the audit module's mutable globals so we can restore them after
    // the suite (other tests rely on the defaults).
    savedAuditDefaults = {
      logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
      target: process.env.PGSERVE_AUDIT_TARGET || 'file',
    };

    overridesQueue = [];

    daemon = new PgserveDaemon({
      controlSocketDir,
      controlSocketPath: resolveControlSocketPath(controlSocketDir),
      pidLockPath: resolvePidLockPath(controlSocketDir),
      libpqCompatPath: resolveLibpqCompatPath(controlSocketDir, 5432),
      auditLogFile: auditFile,
      auditTarget: 'file',
      pgPort: 16700,
      logger: createLogger({ level: process.env.LOG_LEVEL || 'warn' }),
      _fingerprintAcceptOpts: () => overridesQueue.shift() || {},
    });
    await daemon.start();
  });

  afterAll(async () => {
    try { await daemon.stop(); } catch { /* swallow */ }
    _setPeerCredImpl(null);
    if (savedAuditDefaults) configureAudit(savedAuditDefaults);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  beforeEach(async () => {
    overridesQueue.length = 0;
    // Clear pgserve_meta and drop any user DBs from prior tests so each
    // test starts from a clean slate.
    if (daemon._adminClient) {
      try { await daemon._adminClient.query('TRUNCATE pgserve_meta'); } catch { /* schema not yet created in odd cases */ }
      const r = await daemon._adminClient.query(`
        SELECT datname FROM pg_database
        WHERE datname LIKE 'app_%' AND datistemplate = false
      `);
      for (const row of r.rows) {
        try { await daemon._adminClient.query(`DROP DATABASE "${row.datname}"`); } catch { /* swallow */ }
      }
    }
    // Reset audit log so each test reads only its own events.
    try { fs.writeFileSync(auditFile, '', { mode: 0o600 }); } catch { /* swallow */ }
    daemon.enforcementDisabled = false;
  });

  function makeProject(name, dirName = name) {
    const dir = path.join(scratch, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
    return dir;
  }

  function pushOverride(projDir, scriptArgv1 = 'index.js') {
    overridesQueue.push({
      cwdOverride: projDir,
      cmdlineOverride: ['bun', scriptArgv1],
    });
  }

  async function makeClient({ database, expectError = false } = {}) {
    const client = new Client({
      host: controlSocketDir,
      port: 5432,
      database: database || 'postgres',
      user: 'postgres',
      password: 'postgres',
    });
    // pg.Client's end() can hang after a FATAL connect failure (it tries
    // to send a Terminate message on a closed socket), so on the deny path
    // we swallow connect's rejection and return immediately. The TCP
    // socket is already FIN'd by the daemon.
    if (expectError) {
      // Suppress unhandled-error events on the underlying socket.
      client.on('error', () => { /* swallow */ });
      let err;
      try { await client.connect(); } catch (e) { err = e; }
      return { error: err };
    }
    await client.connect();
    return { client };
  }

  function readAudit() {
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  test('two peers with different fingerprints get different DBs', async () => {
    const projA = makeProject('proj-a');
    const projB = makeProject('proj-b');

    pushOverride(projA);
    const { client: ca } = await makeClient();
    const ra = await ca.query('SELECT current_database() AS db');
    await ca.end();

    pushOverride(projB);
    const { client: cb } = await makeClient();
    const rb = await cb.query('SELECT current_database() AS db');
    await cb.end();

    expect(ra.rows[0].db).toMatch(/^app_proj_a_[0-9a-f]{12}$/);
    expect(rb.rows[0].db).toMatch(/^app_proj_b_[0-9a-f]{12}$/);
    expect(ra.rows[0].db).not.toBe(rb.rows[0].db);

    const events = readAudit();
    const created = events.filter((e) => e.event === AUDIT_EVENTS.DB_CREATED);
    expect(created.length).toBe(2);
    expect(created.map((e) => e.database).sort()).toEqual(
      [ra.rows[0].db, rb.rows[0].db].sort(),
    );
  });

  test('same peer reconnecting reaches its existing DB (no second db_created)', async () => {
    const projA = makeProject('reconnect-app');

    pushOverride(projA);
    const { client: c1 } = await makeClient();
    const r1 = await c1.query('SELECT current_database() AS db');
    await c1.end();

    pushOverride(projA);
    const { client: c2 } = await makeClient();
    const r2 = await c2.query('SELECT current_database() AS db');
    await c2.end();

    expect(r2.rows[0].db).toBe(r1.rows[0].db);

    const created = readAudit().filter((e) => e.event === AUDIT_EVENTS.DB_CREATED);
    expect(created.length).toBe(1);
  });

  test('cross-fingerprint connection denied with SQLSTATE 28P01', async () => {
    const projA = makeProject('tenant-a');
    const projB = makeProject('tenant-b');

    // Provision tenant A's DB first.
    pushOverride(projA);
    const { client: ca } = await makeClient();
    const ra = await ca.query('SELECT current_database() AS db');
    await ca.end();
    const tenantADb = ra.rows[0].db;

    // Now have tenant B try to connect explicitly into tenant A's DB.
    pushOverride(projB);
    const { error } = await makeClient({ database: tenantADb, expectError: true });

    expect(error).toBeDefined();
    expect(error.code).toBe('28P01');

    const denied = readAudit().filter(
      (e) => e.event === AUDIT_EVENTS.CONNECTION_DENIED_FINGERPRINT_MISMATCH,
    );
    expect(denied.length).toBe(1);
    expect(denied[0].requested_database).toBe(tenantADb);
    expect(denied[0].owned_database).toMatch(/^app_tenant_b_[0-9a-f]{12}$/);
  });

  test('kill-switch env: cross-fingerprint succeeds and emits audit event', async () => {
    const projA = makeProject('killswitch-a');
    const projB = makeProject('killswitch-b');

    // Provision tenant A.
    pushOverride(projA);
    const { client: ca } = await makeClient();
    const ra = await ca.query('SELECT current_database() AS db');
    await ca.end();
    const tenantADb = ra.rows[0].db;

    // Flip the live kill-switch flag on the daemon (the env var is read
    // once at construction; this is the test seam for the same effect).
    daemon.enforcementDisabled = true;

    pushOverride(projB);
    const { client: cb } = await makeClient({ database: tenantADb });
    const rb = await cb.query('SELECT current_database() AS db');
    await cb.end();

    // Bypass succeeded: tenant B's session reached tenant A's DB.
    expect(rb.rows[0].db).toBe(tenantADb);

    const events = readAudit();
    const bypass = events.filter(
      (e) => e.event === AUDIT_EVENTS.ENFORCEMENT_KILL_SWITCH_USED,
    );
    expect(bypass.length).toBe(1);
    expect(bypass[0].owned_database).toMatch(/^app_killswitch_b_[0-9a-f]{12}$/);
    expect(bypass[0].requested_database).toBe(tenantADb);

    // No deny event should fire while the kill switch is active.
    const denied = events.filter(
      (e) => e.event === AUDIT_EVENTS.CONNECTION_DENIED_FINGERPRINT_MISMATCH,
    );
    expect(denied.length).toBe(0);
  });

  test('sanitizer: name "@scope/foo bar" produces app__scope_foo_bar_<hex>', async () => {
    const projScoped = makeProject('@scope/foo bar', 'scoped-pkg');

    pushOverride(projScoped);
    const { client } = await makeClient();
    const r = await client.query('SELECT current_database() AS db');
    await client.end();

    expect(r.rows[0].db).toMatch(/^app__scope_foo_bar_[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// Boot-time deprecation warning
// ---------------------------------------------------------------------------

describe('boot deprecation warning when kill switch is set', () => {
  test('writes a deprecation message to stderr at start()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-killswitch-boot-'));
    const controlDir = path.join(dir, 'sock');
    fs.mkdirSync(controlDir, { recursive: true });

    const captured = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return origWrite(chunk, ...rest);
    };

    let d;
    try {
      d = new PgserveDaemon({
        controlSocketDir: controlDir,
        controlSocketPath: resolveControlSocketPath(controlDir),
        pidLockPath: resolvePidLockPath(controlDir),
        libpqCompatPath: resolveLibpqCompatPath(controlDir, 5432),
        pgPort: 16780,
        enforcementDisabled: true,
        logger: createLogger({ level: 'warn' }),
      });
      await d.start();

      const merged = captured.join('');
      expect(merged).toContain(KILL_SWITCH_ENV);
      expect(merged).toContain('DISABLED');
      expect(merged).toContain('deprecated');
    } finally {
      process.stderr.write = origWrite;
      try { if (d) await d.stop(); } catch { /* swallow */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });
});
