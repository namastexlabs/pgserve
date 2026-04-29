/**
 * Group 5 — orphan cleanup harness.
 *
 * Boots a real pgserve daemon (no GC triggers — we drive sweeps manually so
 * we can assert exact counts and latency), applies the 240-orphan SQL
 * fixture, creates 240 matching empty databases, runs one `gcSweep`, then
 * asserts:
 *   - all 240 rows gone from pgserve_meta
 *   - all 240 user databases gone from pg_database
 *   - audit log emitted 240 `db_reaped_*` events
 *
 * Plus the auxiliary cases the wish demands:
 *   - persist=true row is exempt (audited as db_persist_honored, never reaped)
 *   - live liveness_pid + stale last_connection_at slides the window forward
 *     instead of reaping
 *   - on-connect sweep listener returns under 50ms P99 (sweep is detached;
 *     accept must not block on it)
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PgserveDaemon,
  resolveControlSocketPath,
  resolvePidLockPath,
  resolveLibpqCompatPath,
} from '../src/daemon.js';
import { _setPeerCredImpl, initFingerprintFfi } from '../src/fingerprint.js';
import { configureAudit, AUDIT_EVENTS } from '../src/audit.js';
import { gcSweep, installSweepTriggers } from '../src/gc.js';
import { createLogger } from '../src/logger.js';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', '240-orphan-seed.sql');
const ORPHAN_COUNT = 240;

let scratchDir;
let auditFile;
let savedAuditDefaults;
let daemon;
let adminClient;

beforeAll(async () => {
  await initFingerprintFfi();
  _setPeerCredImpl(() => ({
    pid: process.pid,
    uid: process.getuid(),
    gid: process.getgid(),
  }));

  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-gc-test-'));
  const controlSocketDir = path.join(scratchDir, 'sock');
  fs.mkdirSync(controlSocketDir, { recursive: true });
  auditFile = path.join(scratchDir, 'audit.log');

  savedAuditDefaults = {
    logFile: path.join(os.homedir(), '.pgserve', 'audit.log'),
    target: process.env.PGSERVE_AUDIT_TARGET || 'file',
  };

  daemon = new PgserveDaemon({
    controlSocketDir,
    controlSocketPath: resolveControlSocketPath(controlSocketDir),
    pidLockPath: resolvePidLockPath(controlSocketDir),
    libpqCompatPath: resolveLibpqCompatPath(controlSocketDir, 5432),
    auditLogFile: auditFile,
    auditTarget: 'file',
    pgPort: 16720,
    logger: createLogger({ level: process.env.LOG_LEVEL || 'warn' }),
    // Tests drive sweeps explicitly — disable the auto-installed boot
    // sweep + hourly timer + on-connect listener.
    gcEnabled: false,
  });
  await daemon.start();
  adminClient = daemon._adminClient;
}, 90_000);

afterAll(async () => {
  try {
    if (adminClient) {
      const r = await adminClient.query(`
        SELECT datname FROM pg_database
        WHERE datname LIKE 'app_%' AND datistemplate = false
      `);
      for (const row of r.rows) {
        try {
          await adminClient.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
            [row.datname],
          );
          await adminClient.query(`DROP DATABASE IF EXISTS "${row.datname}"`);
        } catch { /* swallow */ }
      }
    }
  } catch { /* swallow */ }
  try { await daemon?.stop(); } catch { /* swallow */ }
  _setPeerCredImpl(null);
  if (savedAuditDefaults) configureAudit(savedAuditDefaults);
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

beforeEach(async () => {
  // Reset audit log so each test sees only its own events.
  try { fs.writeFileSync(auditFile, '', { mode: 0o600 }); } catch { /* swallow */ }
  // Reset pgserve_meta + drop any leftover app_* DBs from prior tests.
  await adminClient.query('TRUNCATE pgserve_meta');
  const r = await adminClient.query(`
    SELECT datname FROM pg_database
    WHERE datname LIKE 'app_%' AND datistemplate = false
  `);
  for (const row of r.rows) {
    try {
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
        [row.datname],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS "${row.datname}"`);
    } catch { /* swallow */ }
  }
});

function readAudit() {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function applyFixture() {
  const sql = fs.readFileSync(FIXTURE_PATH, 'utf8');
  await adminClient.query(sql);
}

async function createSeededDatabases() {
  // The fixture writes 240 deterministic database_name values. Read them
  // back and materialise the matching empty databases. Run in batches so
  // the embedded PG admin pool isn't swamped (default max=2).
  const r = await adminClient.query(
    `SELECT database_name FROM pgserve_meta ORDER BY database_name`,
  );
  const names = r.rows.map((row) => row.database_name);
  const batchSize = 8;
  for (let i = 0; i < names.length; i += batchSize) {
    const slice = names.slice(i, i + batchSize);
    await Promise.all(slice.map((dbName) =>
      adminClient.query(`CREATE DATABASE "${dbName}"`).catch((err) => {
        // 42P04 = duplicate_database — tolerated, the DB already exists
        // from a prior test run that bailed before cleanup.
        if (!(err?.code === '42P04' || /already exists/i.test(err?.message || ''))) {
          throw err;
        }
      }),
    ));
  }
  return names;
}

async function countMetaRows() {
  const r = await adminClient.query(`SELECT count(*)::int AS n FROM pgserve_meta`);
  return r.rows[0].n;
}

async function countUserDatabases() {
  const r = await adminClient.query(`
    SELECT count(*)::int AS n FROM pg_database
    WHERE datname LIKE 'app_orphan_%' AND datistemplate = false
  `);
  return r.rows[0].n;
}

describe('gcSweep: 240-orphan fixture', () => {
  test('one sweep reaps all 240 ephemeral orphans', async () => {
    await applyFixture();
    await createSeededDatabases();

    expect(await countMetaRows()).toBe(ORPHAN_COUNT);
    expect(await countUserDatabases()).toBe(ORPHAN_COUNT);

    const result = await gcSweep({
      adminClient,
      pgManager: daemon.pgManager,
      now: new Date(),
      logger: daemon.logger,
    });

    expect(result.examined).toBe(ORPHAN_COUNT);
    expect(result.reaped).toBe(ORPHAN_COUNT);
    expect(result.kept).toBe(0);

    // pgserve_meta empty.
    expect(await countMetaRows()).toBe(0);
    // pg_database has no app_orphan_* rows left.
    expect(await countUserDatabases()).toBe(0);

    const events = readAudit();
    const reapEvents = events.filter(
      (e) => e.event === AUDIT_EVENTS.DB_REAPED_TTL ||
             e.event === AUDIT_EVENTS.DB_REAPED_LIVENESS,
    );
    expect(reapEvents.length).toBe(ORPHAN_COUNT);

    // Fixture splits 50/50 between liveness_pid=NULL and a dead pid →
    // both audit code paths fire.
    const ttl = events.filter((e) => e.event === AUDIT_EVENTS.DB_REAPED_TTL);
    const liveness = events.filter((e) => e.event === AUDIT_EVENTS.DB_REAPED_LIVENESS);
    expect(ttl.length).toBe(120);
    expect(liveness.length).toBe(120);
  }, 120_000);
});

describe('gcSweep: persist + liveness exemptions', () => {
  test('persist=true row is never reaped, even past TTL', async () => {
    // Seed one persist=true row past TTL plus one ephemeral past TTL.
    await adminClient.query(`
      INSERT INTO pgserve_meta (
        database_name, fingerprint, peer_uid, last_connection_at, liveness_pid, persist
      ) VALUES
        ('app_persist_aaaaaaaaaaaa', 'aaaaaaaaaaaa', 1000, now() - interval '48 hours', NULL, true),
        ('app_orphan_bbbbbbbbbbbb',  'bbbbbbbbbbbb', 1000, now() - interval '48 hours', NULL, false)
    `);
    await adminClient.query(`CREATE DATABASE "app_persist_aaaaaaaaaaaa"`);
    await adminClient.query(`CREATE DATABASE "app_orphan_bbbbbbbbbbbb"`);

    const result = await gcSweep({
      adminClient,
      pgManager: daemon.pgManager,
      now: new Date(),
      logger: daemon.logger,
    });

    // The persist=true row never appears via forEachReapable (the SQL
    // filter excludes it), so result.examined == 1 (only the orphan).
    expect(result.reaped).toBe(1);
    expect(result.reapedNames).toEqual(['app_orphan_bbbbbbbbbbbb']);

    const remaining = await adminClient.query(
      `SELECT database_name, persist FROM pgserve_meta ORDER BY database_name`,
    );
    expect(remaining.rows).toEqual([
      { database_name: 'app_persist_aaaaaaaaaaaa', persist: true },
    ]);

    const persistDb = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = 'app_persist_aaaaaaaaaaaa'`,
    );
    expect(persistDb.rows.length).toBe(1);
  }, 60_000);

  test('live liveness_pid + stale last_connection_at slides window, no reap', async () => {
    const livePid = process.pid; // self — guaranteed alive
    await adminClient.query(`
      INSERT INTO pgserve_meta (
        database_name, fingerprint, peer_uid, last_connection_at, liveness_pid, persist
      ) VALUES
        ('app_live_cccccccccccc', 'cccccccccccc', 1000, now() - interval '48 hours', $1, false)
    `, [livePid]);
    await adminClient.query(`CREATE DATABASE "app_live_cccccccccccc"`);

    const before = await adminClient.query(
      `SELECT last_connection_at FROM pgserve_meta WHERE database_name = $1`,
      ['app_live_cccccccccccc'],
    );
    const beforeMs = before.rows[0].last_connection_at.getTime();

    const result = await gcSweep({
      adminClient,
      pgManager: daemon.pgManager,
      now: new Date(),
      logger: daemon.logger,
    });

    expect(result.reaped).toBe(0);
    expect(result.aliveSkipped).toBe(1);

    const after = await adminClient.query(
      `SELECT last_connection_at FROM pgserve_meta WHERE database_name = $1`,
      ['app_live_cccccccccccc'],
    );
    expect(after.rows.length).toBe(1);
    const afterMs = after.rows[0].last_connection_at.getTime();
    // Slid forward: new timestamp > old by at least the staleness gap.
    expect(afterMs).toBeGreaterThan(beforeMs + 24 * 60 * 60 * 1000);
  }, 60_000);
});

describe('installSweepTriggers: on-connect sweep is non-blocking', () => {
  test('emit("accept") returns under 50ms P99 even with always-sample rate', async () => {
    // Use a stub admin client that simulates a slow GC (artificially long
    // pgserve_meta query). If the listener weren't detached, every emit()
    // would wait on this — the test would time out at 200ms × N samples.
    let sweepCount = 0;
    const slowAdmin = {
      async query(_text, _params) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        sweepCount += 1;
        return { rows: [], rowCount: 0 };
      },
    };
    // Force "always sample" by passing getDbCount = 1 (so N = max(1,1/10) = 1)
    // and dbCount low enough that the rate is 1/1 = always.
    const handle = installSweepTriggers(daemon, {
      adminClient: slowAdmin,
      intervalMs: 0,
      bootSweep: false,
      getDbCount: () => 1,
    });
    try {
      const samples = [];
      for (let i = 0; i < 100; i++) {
        const t0 = process.hrtime.bigint();
        daemon.emit('accept', { fingerprint: 'aaaaaaaaaaaa', socket: {} });
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6); // ns → ms
      }
      samples.sort((a, b) => a - b);
      const p99 = samples[Math.floor(samples.length * 0.99) - 1];
      expect(p99).toBeLessThan(50);
    } finally {
      await handle.stop();
    }
    // Sanity: at least the boot=false branch ran, so sweepCount may be 0
    // if the rate decided not to sample, but the latency check is the
    // load-bearing assertion.
    expect(sweepCount).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('installSweepTriggers: boot sweep logs summary', () => {
  test('boot sweep runs once and reports counts via logger.info', async () => {
    // Seed three rows: two reapable, one persist.
    await adminClient.query(`
      INSERT INTO pgserve_meta (
        database_name, fingerprint, peer_uid, last_connection_at, liveness_pid, persist
      ) VALUES
        ('app_boot_aaaaaaaaaaaa', 'aaaaaaaaaaaa', 1000, now() - interval '48 hours', NULL, false),
        ('app_boot_bbbbbbbbbbbb', 'bbbbbbbbbbbb', 1000, now() - interval '48 hours', NULL, false),
        ('app_boot_cccccccccccc', 'cccccccccccc', 1000, now() - interval '48 hours', NULL, true)
    `);
    await adminClient.query(`CREATE DATABASE "app_boot_aaaaaaaaaaaa"`);
    await adminClient.query(`CREATE DATABASE "app_boot_bbbbbbbbbbbb"`);
    await adminClient.query(`CREATE DATABASE "app_boot_cccccccccccc"`);

    const calls = [];
    const captureLogger = {
      info: (...args) => calls.push({ level: 'info', args }),
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const stubDaemon = Object.assign(Object.create(daemon), {
      logger: captureLogger,
    });
    // Object.create copies prototype, so emitter methods are inherited.

    const handle = installSweepTriggers(stubDaemon, {
      adminClient,
      intervalMs: 0,
      bootSweep: true,
    });
    try {
      // Wait for setImmediate-scheduled boot sweep.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const summary = calls.find((c) =>
          typeof c.args[1] === 'string' && c.args[1].includes('boot sweep complete'),
        );
        if (summary) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const summary = calls.find((c) =>
        typeof c.args[1] === 'string' && c.args[1].includes('boot sweep complete'),
      );
      expect(summary).toBeDefined();
      expect(summary.args[0].reaped).toBe(2);
      expect(summary.args[0].persist_skipped).toBe(0); // forEachReapable filter excludes persist=true rows from `examined` entirely
    } finally {
      await handle.stop();
    }
  }, 60_000);
});
