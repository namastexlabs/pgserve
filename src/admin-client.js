/**
 * Admin DB client — small Bun.SQL wrapper exposing the `{query, end}`
 * surface that `src/control-db.js` expects.
 *
 * The daemon and the `pgserve daemon issue-token / revoke-token` CLI
 * subcommands both need a privileged connection to the underlying
 * Postgres instance owned by `PostgresManager`. The pg npm module is
 * a devDependency only (it backs the test harness); rather than promote
 * it to runtime we wrap Bun.SQL — which is shipped with the runtime —
 * in the parameterised-query interface control-db.js documents.
 *
 * Connection target:
 *   - Local Unix socket when `socketDir` is provided (the daemon's
 *     hot path) — drops the bytes onto the kernel-local socket.
 *   - TCP fallback when `socketDir` is null (e.g. CI hosts without
 *     the embedded socket directory present).
 *
 * The CLI side reads the daemon's discovery file at
 * `${controlSocketDir}/admin.json` to learn `{socketDir, port}`.
 */

import { SQL } from 'bun';
import fs from 'fs';
import path from 'path';

/**
 * @param {object} args
 * @param {string|null} [args.socketDir] — accepted for parity with the
 *   embedded-postgres callers but unused; Bun.SQL's startup auth path
 *   does not currently traverse `pg_hba.conf` Unix-socket trust rules
 *   against `embedded-postgres`, so we always go TCP for admin work.
 *   Keeping the parameter avoids a churning call-site signature.
 * @param {string} [args.host='127.0.0.1']
 * @param {number} args.port
 * @param {string} [args.database='postgres']
 * @param {string} [args.user='postgres']
 * @param {string} [args.password='postgres']
 * @param {number} [args.max=2]
 * @param {number} [args.idleTimeout=300]
 * @param {number} [args.queryTimeoutMs=0]
 * @returns {Promise<{supportsQueryOptions: boolean, query: (text: string, params?: any[], opts?: {timeoutMs?: number}) => Promise<{rows: any[], rowCount: number}>, end: () => Promise<void>, sql: any}>}
 */
export async function createAdminClient({
  socketDir: _socketDir = null,
  host = '127.0.0.1',
  port,
  database = 'postgres',
  user = 'postgres',
  password = 'postgres',
  max = 2,
  idleTimeout = 300,
  queryTimeoutMs = 0,
} = {}) {
  if (typeof port !== 'number') throw new Error('createAdminClient: port required');
  const options = {
    hostname: host,
    port,
    database,
    username: user,
    password,
    max,
    idleTimeout,
  };
  let sql = new SQL(options);
  // Light probe so a misconfigured daemon fails loudly here rather than at
  // first query.
  await sql`SELECT 1`;

  async function reopen() {
    const closing = sql;
    sql = new SQL(options);
    void closing.close().catch(() => { /* swallow */ });
    await sql`SELECT 1`;
  }

  return {
    supportsQueryOptions: true,
    get sql() {
      return sql;
    },
    async query(text, params = [], opts = {}) {
      // control-db.js is written for the pg npm module's contract, which
      // requires JSON-stringified payloads bound to JSONB parameters.
      // Bun.SQL goes the other way: it stringifies JS objects when they
      // hit JSONB columns, but a JS string headed for `::jsonb` is sent
      // as a JSON string literal (i.e. `"\"..."\"` rather than the array
      // it represents). Bridge the impedance mismatch here so the same
      // call sites work against either driver.
      const adapted = params.map(coerceJsonbParam);
      const timeoutMs = opts.timeoutMs ?? queryTimeoutMs;
      try {
        return await runQueryWithTimeout(sql, text, adapted, timeoutMs);
      } catch (err) {
        if (!isRetriableAdminQueryError(err)) throw err;
        await reopen();
        return await runQueryWithTimeout(sql, text, adapted, timeoutMs);
      }
    },
    async end() {
      try { await sql.close(); } catch { /* swallow */ }
    },
  };
}

async function runQueryWithTimeout(sql, text, params, queryTimeoutMs) {
  const query = runQuery(sql, text, params);
  return withTimeout(query, queryTimeoutMs);
}

async function runQuery(sql, text, params) {
  const rows = await sql.unsafe(text, params);
  // Bun returns an Array of plain objects with `count` set on it; turn
  // JSONB columns back into JS values so control-db.js's parseTokens
  // sees the array-of-objects shape it would receive from pg.
  const out = Array.from(rows).map(decodeJsonColumns);
  return { rows: out, rowCount: rows.count ?? rows.length ?? 0 };
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`admin query timed out after ${timeoutMs}ms`);
      err.code = 'EADMINQUERYTIMEOUT';
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  promise.catch(() => { /* handled by the race winner */ });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isRetriableAdminQueryError(err) {
  const code = err?.code;
  if (['EADMINQUERYTIMEOUT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ConnectionClosed'].includes(code)) return true;
  const message = err?.message || String(err);
  return /connection (?:closed|terminated|reset)|socket closed|timeout|CONNECTION_ENDED|CONNECTION_DESTROYED/i.test(message);
}

/**
 * Strings shaped like a JSON array or object are unwrapped so Bun.SQL's
 * automatic JSONB serialiser sees the JS value (not a quoted JSON string).
 * Anything else is passed through untouched. This mirrors what node-pg
 * does implicitly when the column type is JSONB.
 */
function coerceJsonbParam(p) {
  if (typeof p !== 'string') return p;
  const trimmed = p.trim();
  if (trimmed.length === 0) return p;
  const first = trimmed[0];
  if (first !== '[' && first !== '{') return p;
  try {
    return JSON.parse(p);
  } catch {
    return p;
  }
}

/**
 * Bun.SQL returns JSONB values as the JSON text rather than parsed JS.
 * Re-parse the obvious cases so callers expecting node-pg's auto-decoded
 * shape get arrays/objects.
 */
function decodeJsonColumns(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try { out[key] = JSON.parse(v); } catch { out[key] = v; }
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Daemon-side: write a small JSON file that issue-token / revoke-token
 * subcommands read to find the admin socket.
 *
 * @param {object} args
 * @param {string} args.controlSocketDir
 * @param {string|null} args.socketDir — PG socket directory (nullable on Windows)
 * @param {number} args.port
 * @returns {string} the absolute path to the discovery file
 */
export function writeAdminDiscovery({ controlSocketDir, socketDir, port }) {
  const file = path.join(controlSocketDir, 'admin.json');
  const payload = {
    socketDir,
    port,
    host: socketDir ? null : '127.0.0.1',
    pid: process.pid,
    written_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  return file;
}

/**
 * CLI-side: read the daemon's discovery file.
 *
 * @param {string} controlSocketDir
 * @returns {{socketDir: string|null, port: number, host: string|null}}
 */
export function readAdminDiscovery(controlSocketDir) {
  const file = path.join(controlSocketDir, 'admin.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

/**
 * CLI-side: best-effort cleanup at daemon shutdown.
 *
 * @param {string} controlSocketDir
 */
export function removeAdminDiscovery(controlSocketDir) {
  const file = path.join(controlSocketDir, 'admin.json');
  try { fs.unlinkSync(file); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
