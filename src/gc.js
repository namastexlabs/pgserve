/**
 * pgserve GC — 3-layer lifecycle sweep (Group 5).
 *
 * Decides which user databases to reap based on:
 *   1. `persist=true` — exempt from GC, audited as `db_persist_honored`.
 *   2. Liveness — if `liveness_pid` points at a running process, slide
 *      `last_connection_at` forward to "now" (the peer is alive, the row is
 *      a heartbeat) and never reap.
 *   3. TTL — peer is gone AND `now - last_connection_at > ttlMs` (default
 *      24h) → `DROP DATABASE`, delete the meta row, audit reap event.
 *
 * Audit reap event is `db_reaped_liveness` when the row had a non-null
 * liveness_pid that is now dead, otherwise `db_reaped_ttl` (the row never
 * registered a liveness_pid — pure idle expiry).
 *
 * `installSweepTriggers(daemon, …)` wires the three call sites:
 *   - boot: a single sweep right after the daemon is listening, with a
 *     summary log line so operators see GC activity at startup.
 *   - hourly `setInterval` (configurable via `intervalMs`).
 *   - on-connect sampling: subscribe to the daemon's `'accept'` event and
 *     fire `gcSweep` async at rate 1/N where `N = max(1, dbCount/10)`. The
 *     listener never awaits the sweep, so accept latency is unaffected.
 */

import { audit, AUDIT_EVENTS } from './audit.js';
import { forEachReapable, deleteMetaRow, touchLastConnection } from './control-db.js';

const TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

/**
 * Default liveness probe — POSIX `kill(pid, 0)` returns 0 if the process is
 * alive, throws ESRCH if gone, EPERM if owned by another user (still alive).
 *
 * @param {number|null|undefined} pid
 * @returns {boolean}
 */
function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * @typedef {object} GcSweepOptions
 * @property {{query: Function}} adminClient — pgserve admin DB connection
 * @property {{adminPool: any, createdDatabases?: Set<string>}} [pgManager] —
 *   optional; used to evict from the in-process createdDatabases cache after
 *   a successful DROP. Tests can omit; gcSweep always falls back to the
 *   adminClient's `query()` for the actual DROP.
 * @property {number|Date} [now]
 * @property {number} [ttlMs] — defaults to 24h
 * @property {boolean} [dryRun] — when true, never DROP / DELETE / audit reap
 * @property {(pid: number|null|undefined) => boolean} [isProcessAlive]
 * @property {{warn?: Function, info?: Function, error?: Function, debug?: Function}} [logger]
 */

/**
 * @typedef {object} GcSweepResult
 * @property {number} examined
 * @property {number} reaped
 * @property {number} kept
 * @property {number} persistSkipped
 * @property {number} aliveSkipped
 * @property {string[]} reapedNames
 */

/**
 * Run one GC sweep. Returns counts so callers can log a summary or assert
 * in tests.
 *
 * @param {GcSweepOptions} opts
 * @returns {Promise<GcSweepResult>}
 */
export async function gcSweep({
  adminClient,
  pgManager = null,
  now = new Date(),
  ttlMs = TTL_MS_DEFAULT,
  dryRun = false,
  isProcessAlive = defaultIsProcessAlive,
  logger,
} = {}) {
  if (!adminClient) throw new Error('gcSweep: adminClient required');

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('gcSweep: now must be Date or numeric ms');

  const result = {
    examined: 0,
    reaped: 0,
    kept: 0,
    persistSkipped: 0,
    aliveSkipped: 0,
    reapedNames: [],
  };

  // Snapshot so we don't iterate while we DELETE — pg's async iterator
  // protocols vary across drivers, but materialising 240 rows is cheap and
  // sidesteps any cursor-vs-DELETE quirks.
  const candidates = [];
  for await (const row of forEachReapable(adminClient)) {
    candidates.push(row);
  }

  for (const row of candidates) {
    result.examined += 1;

    // Persist=true rows never appear from forEachReapable (the query filters
    // them out), but if the schema changes that contract we still defend
    // here — and emit the audit event the wish promises.
    if (row.persist) {
      result.persistSkipped += 1;
      result.kept += 1;
      if (!dryRun) {
        audit(AUDIT_EVENTS.DB_PERSIST_HONORED, {
          database: row.databaseName,
          fingerprint: row.fingerprint,
        });
      }
      continue;
    }

    const livenessPid = row.livenessPid;
    const hadLivenessPid = Number.isInteger(livenessPid) && livenessPid > 0;
    const alive = hadLivenessPid && isProcessAlive(livenessPid);

    if (alive) {
      result.aliveSkipped += 1;
      result.kept += 1;
      if (!dryRun) {
        // Slide the window: an alive process means the row is effectively
        // current, even if the pgserve_meta last_connection_at value lags.
        try {
          await touchLastConnection(adminClient, {
            databaseName: row.databaseName,
            livenessPid,
          });
        } catch (err) {
          logger?.warn?.(
            { err: err?.message || String(err), database: row.databaseName },
            'gcSweep: touchLastConnection failed for live row (non-fatal)',
          );
        }
      }
      continue;
    }

    const lastMs = row.lastConnectionAt instanceof Date
      ? row.lastConnectionAt.getTime()
      : Number(row.lastConnectionAt);
    const ageMs = Number.isFinite(lastMs) ? nowMs - lastMs : Infinity;

    if (ageMs <= ttlMs) {
      result.kept += 1;
      continue;
    }

    if (dryRun) {
      result.reaped += 1;
      result.reapedNames.push(row.databaseName);
      continue;
    }

    try {
      await dropDatabaseSafely(adminClient, row.databaseName, logger);
      pgManager?.createdDatabases?.delete(row.databaseName);
      await deleteMetaRow(adminClient, row.databaseName);
      const reapEvent = hadLivenessPid
        ? AUDIT_EVENTS.DB_REAPED_LIVENESS
        : AUDIT_EVENTS.DB_REAPED_TTL;
      audit(reapEvent, {
        database: row.databaseName,
        fingerprint: row.fingerprint,
        last_connection_at: row.lastConnectionAt instanceof Date
          ? row.lastConnectionAt.toISOString()
          : row.lastConnectionAt,
        liveness_pid: livenessPid ?? null,
        age_ms: Number.isFinite(ageMs) ? ageMs : null,
      });
      result.reaped += 1;
      result.reapedNames.push(row.databaseName);
    } catch (err) {
      logger?.error?.(
        { err: err?.message || String(err), database: row.databaseName },
        'gcSweep: failed to reap database',
      );
    }
  }

  return result;
}

async function dropDatabaseSafely(adminClient, databaseName, logger) {
  const escaped = `"${databaseName.replace(/"/g, '""')}"`;
  // Terminate any lingering backends so DROP DATABASE doesn't refuse with
  // 55006 (object_in_use). The peer's pgserve daemon socket is already gone
  // (liveness dead) but Postgres can hold idle backends a while longer.
  try {
    await adminClient.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
  } catch (err) {
    logger?.debug?.(
      { err: err?.message || String(err), database: databaseName },
      'gcSweep: pg_terminate_backend failed (non-fatal)',
    );
  }
  await adminClient.query(`DROP DATABASE IF EXISTS ${escaped}`);
}

/**
 * Wire the three sweep call sites onto a running daemon.
 *
 * Returns a `{stop()}` handle so tests (and `daemon.stop()`) can detach.
 *
 * @param {object} daemon — PgserveDaemon instance
 * @param {object} [opts]
 * @param {{query: Function}} [opts.adminClient] — defaults to daemon._adminClient
 * @param {number} [opts.intervalMs] — hourly default; pass 0 to disable
 * @param {number} [opts.ttlMs]
 * @param {(pid: number) => boolean} [opts.isProcessAlive]
 * @param {() => Promise<number>|number} [opts.getDbCount] — defaults to a
 *   COUNT(*) query against pgserve_meta
 * @param {boolean} [opts.bootSweep=true]
 * @returns {{stop: () => Promise<void>, sweep: () => Promise<GcSweepResult>}}
 */
export function installSweepTriggers(daemon, opts = {}) {
  const adminClient = opts.adminClient || daemon._adminClient;
  if (!adminClient) {
    throw new Error('installSweepTriggers: daemon has no admin client');
  }
  const intervalMs = opts.intervalMs == null ? HOURLY_MS : opts.intervalMs;
  const ttlMs = opts.ttlMs == null ? TTL_MS_DEFAULT : opts.ttlMs;
  const logger = daemon.logger;
  const pgManager = daemon.pgManager;
  const isProcessAlive = opts.isProcessAlive || defaultIsProcessAlive;
  const getDbCount = opts.getDbCount || (async () => {
    try {
      const r = await adminClient.query('SELECT count(*)::int AS n FROM pgserve_meta');
      return r.rows?.[0]?.n ?? 0;
    } catch {
      return 0;
    }
  });

  let stopped = false;
  let inflight = false;
  let lastDbCount = 0;

  const runSweep = async () => {
    if (stopped) return null;
    if (inflight) return null;
    inflight = true;
    try {
      const res = await gcSweep({
        adminClient,
        pgManager,
        now: new Date(),
        ttlMs,
        isProcessAlive,
        logger,
      });
      lastDbCount = Math.max(0, lastDbCount - res.reaped);
      return res;
    } catch (err) {
      logger?.error?.(
        { err: err?.message || String(err) },
        'gcSweep failed',
      );
      return null;
    } finally {
      inflight = false;
    }
  };

  let timer = null;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      void runSweep();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const acceptListener = () => {
    // Sample 1/N where N = max(1, ceil(dbCount/10)). Always async and
    // detached so accept latency isn't blocked.
    const n = Math.max(1, Math.ceil(lastDbCount / 10));
    if (n === 1 || Math.random() * n < 1) {
      setImmediate(() => {
        if (stopped) return;
        // Refresh count opportunistically before each sweep so on-connect
        // sampling tracks the live row count without polling.
        Promise.resolve(getDbCount())
          .then((c) => { lastDbCount = Number(c) || 0; })
          .then(runSweep)
          .catch(() => { /* swallowed by runSweep */ });
      });
    }
  };
  daemon.on?.('accept', acceptListener);

  const handle = {
    sweep: runSweep,
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      daemon.off?.('accept', acceptListener);
    },
  };

  if (opts.bootSweep !== false) {
    // Boot sweep + count refresh + summary log. Detached so we don't block
    // start() — the daemon is already listening at this point.
    setImmediate(async () => {
      try {
        lastDbCount = Number(await getDbCount()) || 0;
        const res = await runSweep();
        if (res) {
          logger?.info?.(
            {
              examined: res.examined,
              reaped: res.reaped,
              kept: res.kept,
              persist_skipped: res.persistSkipped,
              alive_skipped: res.aliveSkipped,
            },
            'pgserve GC: boot sweep complete',
          );
        }
      } catch (err) {
        logger?.warn?.(
          { err: err?.message || String(err) },
          'pgserve GC: boot sweep failed',
        );
      }
    });
  }

  return handle;
}

export const _internals = Object.freeze({
  TTL_MS_DEFAULT,
  HOURLY_MS,
  defaultIsProcessAlive,
});
