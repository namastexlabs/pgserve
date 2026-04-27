/**
 * pgserve control DB — `pgserve_meta` schema + accessors.
 *
 * The pgserve daemon owns a control database (the "admin DB"). This module
 * defines the `pgserve_meta` table that records every user database the
 * daemon provisions per peer fingerprint, plus the small set of accessors
 * the daemon (Wave 2+) and GC sweep (Group 5) call against it.
 *
 * Schema (see DESIGN.md §9):
 *   database_name      TEXT PRIMARY KEY
 *   fingerprint        TEXT NOT NULL          -- 12 hex chars from sha256
 *   peer_uid           INTEGER NOT NULL
 *   package_realpath   TEXT                   -- NULL for script fallback
 *   created_at         TIMESTAMPTZ DEFAULT now()
 *   last_connection_at TIMESTAMPTZ DEFAULT now()
 *   liveness_pid       INTEGER
 *   persist            BOOLEAN DEFAULT false
 *
 * Client contract: any object exposing
 *   `query(text: string, params?: unknown[]) => Promise<{ rows: object[] }>`
 * (matches `pg.Client` / `pg.Pool` directly; trivial to wrap Bun.SQL).
 */

const REAPABLE_QUERY = `
  SELECT database_name, fingerprint, last_connection_at, liveness_pid, persist
  FROM pgserve_meta
  WHERE persist = false
  ORDER BY last_connection_at ASC
`;

/**
 * Create the `pgserve_meta` table if it does not already exist.
 * Safe to call repeatedly — used at daemon boot and in tests.
 *
 * @param {{query: Function}} client
 * @returns {Promise<void>}
 */
export async function ensureMetaSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pgserve_meta (
      database_name      TEXT PRIMARY KEY,
      fingerprint        TEXT NOT NULL,
      peer_uid           INTEGER NOT NULL,
      package_realpath   TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_connection_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      liveness_pid       INTEGER,
      persist            BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS pgserve_meta_fingerprint_idx
    ON pgserve_meta (fingerprint)
  `);
}

/**
 * Insert (or upsert) a row marking a freshly-created user DB.
 *
 * @param {{query: Function}} client
 * @param {object} row
 * @param {string} row.databaseName
 * @param {string} row.fingerprint
 * @param {number} row.peerUid
 * @param {string|null} [row.packageRealpath]
 * @param {number|null} [row.livenessPid]
 * @param {boolean} [row.persist]
 */
export async function recordDbCreated(client, {
  databaseName,
  fingerprint,
  peerUid,
  packageRealpath = null,
  livenessPid = null,
  persist = false,
}) {
  if (!databaseName) throw new Error('recordDbCreated: databaseName required');
  if (!fingerprint) throw new Error('recordDbCreated: fingerprint required');
  if (typeof peerUid !== 'number') throw new Error('recordDbCreated: peerUid must be number');

  await client.query(
    `
    INSERT INTO pgserve_meta
      (database_name, fingerprint, peer_uid, package_realpath, liveness_pid, persist)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (database_name) DO UPDATE SET
      fingerprint        = EXCLUDED.fingerprint,
      peer_uid           = EXCLUDED.peer_uid,
      package_realpath   = EXCLUDED.package_realpath,
      liveness_pid       = EXCLUDED.liveness_pid,
      persist            = EXCLUDED.persist,
      last_connection_at = now()
    `,
    [databaseName, fingerprint, peerUid, packageRealpath, livenessPid, persist],
  );
}

/**
 * Slide the connection window: bump last_connection_at and refresh
 * liveness_pid on every accept for an existing fingerprint.
 *
 * @param {{query: Function}} client
 * @param {{databaseName: string, livenessPid?: number|null}} args
 */
export async function touchLastConnection(client, { databaseName, livenessPid = null }) {
  if (!databaseName) throw new Error('touchLastConnection: databaseName required');
  await client.query(
    `
    UPDATE pgserve_meta
    SET last_connection_at = now(),
        liveness_pid       = $2
    WHERE database_name = $1
    `,
    [databaseName, livenessPid],
  );
}

/**
 * Set the persist flag for a database (true = exempt from GC).
 *
 * @param {{query: Function}} client
 * @param {string} databaseName
 * @param {boolean} value
 */
export async function markPersist(client, databaseName, value) {
  if (!databaseName) throw new Error('markPersist: databaseName required');
  await client.query(
    `UPDATE pgserve_meta SET persist = $2 WHERE database_name = $1`,
    [databaseName, !!value],
  );
}

/**
 * Async iterator over candidate DBs for the GC sweep.
 * Skips persist=true rows entirely (they are never reaped).
 *
 * Group 5 consumes this and applies its liveness/TTL policy.
 *
 * @param {{query: Function}} client
 * @param {{now?: Date}} [opts] — `now` accepted for caller symmetry; the
 *   policy decision (TTL elapsed?) lives in Group 5, not here.
 * @returns {AsyncIterable<{
 *   databaseName: string,
 *   fingerprint: string,
 *   lastConnectionAt: Date,
 *   livenessPid: number|null,
 *   persist: boolean,
 * }>}
 */
export async function* forEachReapable(client, _opts = {}) {
  const result = await client.query(REAPABLE_QUERY);
  for (const row of result.rows) {
    yield {
      databaseName: row.database_name,
      fingerprint: row.fingerprint,
      lastConnectionAt: row.last_connection_at,
      livenessPid: row.liveness_pid,
      persist: row.persist,
    };
  }
}

/**
 * Delete a row after the user DB has been DROPped. Group 5 helper.
 *
 * @param {{query: Function}} client
 * @param {string} databaseName
 */
export async function deleteMetaRow(client, databaseName) {
  await client.query(`DELETE FROM pgserve_meta WHERE database_name = $1`, [databaseName]);
}
