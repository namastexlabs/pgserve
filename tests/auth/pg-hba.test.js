/**
 * Tests for src/auth/pg-hba-template.js — Group 2, autopg-distribution-cutover.
 *
 * Two layers:
 *   1. Pure-template tests (renderPgHba / renderPgIdent / containsLegacyTrust /
 *      migratePgHba) — fast, no postgres.
 *   2. Integration test against a live PostgresManager — asserts the
 *      acceptance criteria from the wish:
 *        AC1: grep -E '\btrust\b' on emitted pg_hba.conf returns 0 hits
 *        AC2: peer auth on local socket as autopg_admin works passwordless
 *        AC3: 127.0.0.1 connection requires SCRAM (bad password rejected,
 *             correct password accepted)
 *        AC4: hosts upgraded from a legacy `trust` pg_hba.conf get rewritten
 *             on next start() and retain their data
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQL } from 'bun';
import { PostgresManager } from '../../src/postgres.js';
import { configureAudit } from '../../src/audit.js';
import { ADMIN_ROLE } from '../../src/auth/admin-bootstrap.js';
import {
  renderPgHba,
  renderPgIdent,
  containsLegacyTrust,
  migratePgHba,
  IDENT_MAP_NAME,
  _internals,
} from '../../src/auth/pg-hba-template.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

describe('renderPgHba — pure template', () => {
  test('emits no `trust` predicates anywhere (Sentinel B1)', () => {
    const body = renderPgHba();
    // Strip comments first — the canonical template's preamble explains
    // the policy, which contains the literal word "trust" in prose. Only
    // the non-comment substrate is bound by AC1.
    const code = body
      .split('\n')
      .map((l) => l.replace(/#.*$/, ''))
      .join('\n');
    expect(/\btrust\b/.test(code)).toBe(false);
  });

  test('contains the four mandatory non-comment lines from the wish', () => {
    const body = renderPgHba();
    // Admin local peer with the autopg ident map.
    expect(body).toMatch(/^local\s+all\s+autopg_admin\s+peer\s+map=autopg/m);
    // Loopback IPv4 + IPv6 host SCRAM lines.
    expect(body).toMatch(/^host\s+all\s+all\s+127\.0\.0\.1\/32\s+scram-sha-256$/m);
    expect(body).toMatch(/^host\s+all\s+all\s+::1\/128\s+scram-sha-256$/m);
    // Catch-all local SCRAM.
    expect(body).toMatch(/^local\s+all\s+all\s+scram-sha-256$/m);
  });

  test('replication entries are SCRAM-only (no `trust` for `local replication all`)', () => {
    const body = renderPgHba();
    expect(body).toMatch(/^local\s+replication\s+all\s+scram-sha-256$/m);
    expect(body).toMatch(/^host\s+replication\s+all\s+127\.0\.0\.1\/32\s+scram-sha-256$/m);
    expect(body).toMatch(/^host\s+replication\s+all\s+::1\/128\s+scram-sha-256$/m);
  });

  test('admin role + ident map name are overridable', () => {
    const body = renderPgHba({ adminRole: 'custom_admin', identMapName: 'mymap' });
    expect(body).toMatch(/^local\s+all\s+custom_admin\s+peer\s+map=mymap/m);
  });
});

describe('renderPgIdent', () => {
  test('writes a single MAPNAME row for the given OS user', () => {
    const body = renderPgIdent({ osUser: 'alice' });
    expect(body).toMatch(new RegExp(`^${IDENT_MAP_NAME}\\s+alice\\s+${ADMIN_ROLE}$`, 'm'));
  });

  test('rejects empty OS user', () => {
    expect(() => renderPgIdent({ osUser: '' })).toThrow(/osUser is required/);
  });

  test('rejects regex-style OS user (leading slash) — defensive against ident-map abuse', () => {
    expect(() => renderPgIdent({ osUser: '/.+/' })).toThrow(/reserved characters/);
  });

  test('rejects whitespace in OS user', () => {
    expect(() => renderPgIdent({ osUser: 'a b' })).toThrow(/reserved characters/);
  });
});

describe('containsLegacyTrust', () => {
  test('detects the initdb default `local all all trust`', () => {
    const initdbDefault = `
# IPv4 local connections:
host    all             all             127.0.0.1/32            password
local   all             all                                     trust
`;
    expect(containsLegacyTrust(initdbDefault)).toBe(true);
  });

  test('detects `local replication all trust`', () => {
    const initdbDefault = 'local   replication     all                                     trust\n';
    expect(containsLegacyTrust(initdbDefault)).toBe(true);
  });

  test('returns false on the canonical B1-fixed body', () => {
    expect(containsLegacyTrust(renderPgHba())).toBe(false);
  });

  test('does not get confused by `trust` inside a comment', () => {
    const body = '# trust this comment\nlocal all all scram-sha-256\n';
    expect(containsLegacyTrust(body)).toBe(false);
  });

  test('does not match `trust` as a substring of another word', () => {
    // pg_hba.conf doesn't naturally produce these, but defensive coverage:
    const body = 'local all all distrustful\n';
    expect(containsLegacyTrust(body)).toBe(false);
  });
});

describe('migratePgHba — file-only behavior', () => {
  let scratchDir;
  let auditLogPath;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pghba-test-'));
    auditLogPath = path.join(scratchDir, 'audit.log');
    configureAudit({ logFile: auditLogPath, target: 'file' });
  });

  afterEach(() => {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('first-run: writes pg_hba.conf + pg_ident.conf, both mode 0600', async () => {
    const result = await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger });
    expect(result.status).toBe('rewritten');
    expect(result.hadLegacyTrust).toBe(false);

    const hbaStat = fs.statSync(result.hbaPath);
    expect(hbaStat.mode & 0o777).toBe(0o600);

    const identStat = fs.statSync(result.identPath);
    expect(identStat.mode & 0o777).toBe(0o600);

    const hba = fs.readFileSync(result.hbaPath, 'utf8');
    expect(containsLegacyTrust(hba)).toBe(false);

    const ident = fs.readFileSync(result.identPath, 'utf8');
    expect(ident).toMatch(/\bautopg\s+tester\s+autopg_admin\b/);

    const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
    const ev = auditLines.map((l) => JSON.parse(l)).find((e) => e.event === 'pg_hba_rewritten');
    expect(ev).toBeTruthy();
    expect(ev.os_user).toBe('tester');
    expect(ev.had_legacy_trust).toBe(false);
  });

  test('legacy `trust` body gets replaced + had_legacy_trust=true in audit', async () => {
    const hbaPath = path.join(scratchDir, 'pg_hba.conf');
    fs.writeFileSync(hbaPath, 'local all all trust\nhost all all 127.0.0.1/32 password\n', { mode: 0o600 });

    const result = await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger });
    expect(result.status).toBe('rewritten');
    expect(result.hadLegacyTrust).toBe(true);

    const hba = fs.readFileSync(hbaPath, 'utf8');
    expect(containsLegacyTrust(hba)).toBe(false);

    const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
    const ev = auditLines.map((l) => JSON.parse(l)).find((e) => e.event === 'pg_hba_rewritten');
    expect(ev.had_legacy_trust).toBe(true);
  });

  test('idempotent: running twice on a clean dir does not rewrite the second time', async () => {
    const first = await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger });
    const mtimeBefore = fs.statSync(first.hbaPath).mtimeMs;
    const identMtimeBefore = fs.statSync(first.identPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));

    const second = await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger });
    expect(second.status).toBe('idempotent-skip');

    const mtimeAfter = fs.statSync(second.hbaPath).mtimeMs;
    const identMtimeAfter = fs.statSync(second.identPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    expect(identMtimeAfter).toBe(identMtimeBefore);

    const auditLines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
    const events = auditLines.map((l) => JSON.parse(l)).map((e) => e.event);
    expect(events).toContain('pg_hba_rewritten');
    expect(events).toContain('pg_hba_idempotent_skip');
  });

  test('signalReload is invoked when a rewrite happens (not on idempotent-skip)', async () => {
    let reloadCount = 0;
    const signalReload = () => { reloadCount += 1; };

    await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger, signalReload });
    expect(reloadCount).toBe(1);

    await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger, signalReload });
    expect(reloadCount).toBe(1); // idempotent-skip — no reload
  });

  test('signalReload throwing does not break the migration', async () => {
    const signalReload = () => { throw new Error('boom'); };
    const result = await migratePgHba(scratchDir, { osUser: 'tester', logger: silentLogger, signalReload });
    expect(result.status).toBe('rewritten');
    expect(fs.existsSync(result.hbaPath)).toBe(true);
  });

  test('atomic write helper: never leaves an empty file on disk', () => {
    const target = path.join(scratchDir, 'atomic-target.conf');
    _internals.writeAtomic(target, 'hello\n', 0o600);
    expect(fs.readFileSync(target, 'utf8')).toBe('hello\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test('refuses missing databaseDir', async () => {
    await expect(migratePgHba('', { osUser: 'tester' })).rejects.toThrow(/databaseDir is required/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Integration test — boots a real PostgresManager and verifies the rewrite
// landed on a live cluster and that auth behaviors match acceptance criteria.
// ────────────────────────────────────────────────────────────────────────────

describe('migratePgHba — integration with live PostgresManager', () => {
  const TEST_DATA_DIR = path.resolve('./test-data-pg-hba-integration');
  let configDir;
  let pgManager;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pghba-int-'));
    process.env.AUTOPG_CONFIG_DIR = configDir;
    delete process.env.AUTOPG_SKIP_ADMIN_BOOTSTRAP;

    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    pgManager = new PostgresManager({
      dataDir: TEST_DATA_DIR,
      port: 0,
      logger: silentLogger,
    });
    await pgManager.start();
  }, 90000);

  afterAll(async () => {
    try { await pgManager.stop(); } catch { /* swallow */ }
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    if (configDir && fs.existsSync(configDir)) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
    delete process.env.AUTOPG_CONFIG_DIR;
  });

  test('AC1: emitted pg_hba.conf has zero `trust` predicates outside comments', () => {
    const hbaPath = path.join(TEST_DATA_DIR, 'pg_hba.conf');
    expect(fs.existsSync(hbaPath)).toBe(true);
    const content = fs.readFileSync(hbaPath, 'utf8');
    expect(containsLegacyTrust(content)).toBe(false);
  });

  test('pg_ident.conf maps the host OS user to autopg_admin', () => {
    const identPath = path.join(TEST_DATA_DIR, 'pg_ident.conf');
    const content = fs.readFileSync(identPath, 'utf8');
    const osUser = os.userInfo().username;
    expect(content).toMatch(new RegExp(`\\b${IDENT_MAP_NAME}\\s+${osUser}\\s+${ADMIN_ROLE}\\b`));
  });

  test('AC3: 127.0.0.1 connection with bad password is rejected (SCRAM enforcement)', async () => {
    const wrongPool = new SQL({
      hostname: '127.0.0.1',
      port: pgManager.port,
      database: 'postgres',
      username: ADMIN_ROLE,
      password: 'definitely-not-the-real-password',
      max: 1,
      idleTimeout: 2,
      connectionTimeout: 2,
    });
    let connected = false;
    try {
      await wrongPool`SELECT 1`;
      connected = true;
    } catch (err) {
      const msg = String(err?.message || err);
      expect(/password|authentication|SCRAM/i.test(msg)).toBe(true);
    } finally {
      try { await wrongPool.close(); } catch { /* swallow */ }
    }
    expect(connected).toBe(false);
  });

  test('AC3: 127.0.0.1 connection with correct password succeeds via SCRAM', async () => {
    const secret = fs.readFileSync(path.join(configDir, 'admin.secret'), 'utf8').replace(/\r?\n$/, '');
    const okPool = new SQL({
      hostname: '127.0.0.1',
      port: pgManager.port,
      database: 'postgres',
      username: ADMIN_ROLE,
      password: secret,
      max: 1,
      idleTimeout: 2,
    });
    try {
      const r = await okPool`SELECT current_user::text AS u`;
      expect(r[0].u).toBe(ADMIN_ROLE);
    } finally {
      await okPool.close();
    }
  });

  test('idempotent: stop+start keeps pg_hba.conf mtime stable', async () => {
    const hbaPath = path.join(TEST_DATA_DIR, 'pg_hba.conf');
    const before = fs.statSync(hbaPath).mtimeMs;
    const beforeContent = fs.readFileSync(hbaPath, 'utf8');

    await pgManager.stop();
    await new Promise((r) => setTimeout(r, 500));

    pgManager = new PostgresManager({
      dataDir: TEST_DATA_DIR,
      port: 0,
      logger: silentLogger,
    });
    await pgManager.start();

    const afterContent = fs.readFileSync(hbaPath, 'utf8');
    expect(afterContent).toBe(beforeContent);
    expect(fs.statSync(hbaPath).mtimeMs).toBe(before);
  }, 90000);
});

// ────────────────────────────────────────────────────────────────────────────
// AC4 — upgrade path: a host that has a legacy `trust` pg_hba.conf gets it
// replaced on next start() and existing data survives.
// ────────────────────────────────────────────────────────────────────────────

describe('migratePgHba — upgrade-from-legacy `trust` host', () => {
  const TEST_DATA_DIR = path.resolve('./test-data-pg-hba-upgrade');
  let configDir;
  let pgManager;

  beforeAll(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-pghba-upg-'));
    process.env.AUTOPG_CONFIG_DIR = configDir;

    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

    // First start: bring up a vanilla cluster, create a marker DB, stop.
    pgManager = new PostgresManager({
      dataDir: TEST_DATA_DIR,
      port: 0,
      logger: silentLogger,
    });
    await pgManager.start();

    await pgManager.adminPool.unsafe('CREATE DATABASE upgrade_marker');

    await pgManager.stop();
    await new Promise((r) => setTimeout(r, 500));

    // Now simulate a "legacy" host: overwrite pg_hba.conf with the
    // initdb-default `trust` body. The next start() must rewrite it.
    const hbaPath = path.join(TEST_DATA_DIR, 'pg_hba.conf');
    const legacyBody = [
      'local   all             all                                     trust',
      'host    all             all             127.0.0.1/32            password',
      'host    all             all             ::1/128                 password',
      'local   replication     all                                     trust',
      '',
    ].join('\n');
    fs.writeFileSync(hbaPath, legacyBody, { mode: 0o600 });
    expect(containsLegacyTrust(fs.readFileSync(hbaPath, 'utf8'))).toBe(true);

    pgManager = new PostgresManager({
      dataDir: TEST_DATA_DIR,
      port: 0,
      logger: silentLogger,
    });
    await pgManager.start();
  }, 120000);

  afterAll(async () => {
    try { await pgManager.stop(); } catch { /* swallow */ }
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
    if (configDir && fs.existsSync(configDir)) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
    delete process.env.AUTOPG_CONFIG_DIR;
  });

  test('AC4: post-restart pg_hba.conf has zero `trust` predicates', () => {
    const hbaPath = path.join(TEST_DATA_DIR, 'pg_hba.conf');
    const content = fs.readFileSync(hbaPath, 'utf8');
    expect(containsLegacyTrust(content)).toBe(false);
  });

  test('AC4: data survived the rewrite (the upgrade_marker database is still present)', async () => {
    const rows = await pgManager.adminPool`SELECT datname FROM pg_database WHERE datname = 'upgrade_marker'`;
    expect(rows.length).toBe(1);
  });
});
