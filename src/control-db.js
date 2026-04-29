/**
 * pgserve control DB — `pgserve_meta` schema + accessors.
 *
 * The pgserve daemon owns a control database (the "admin DB"). This module
 * defines the `pgserve_meta` table that records every user database the
 * daemon provisions per peer fingerprint, plus the small set of accessors
 * the daemon (Wave 2+) and GC sweep (Group 5) call against it.
 *
 * Schema (see DESIGN.md §9 + Group 6 token migration):
 *   database_name      TEXT PRIMARY KEY
 *   fingerprint        TEXT NOT NULL          -- 12 hex chars from sha256
 *   peer_uid           INTEGER NOT NULL
 *   package_realpath   TEXT                   -- NULL for script fallback
 *   created_at         TIMESTAMPTZ DEFAULT now()
 *   last_connection_at TIMESTAMPTZ DEFAULT now()
 *   liveness_pid       INTEGER
 *   persist            BOOLEAN DEFAULT false
 *   allowed_tokens     JSONB DEFAULT '[]'     -- Group 6: bearer tokens for TCP path
 *
 * Each `allowed_tokens` entry is `{id, hash, issued_at}` where `hash` is the
 * sha256 of the bearer token (the cleartext is shown to the operator once
 * during `pgserve daemon issue-token` and never persisted).
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
      persist            BOOLEAN NOT NULL DEFAULT false,
      allowed_tokens     JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  // Group 6 migration: existing v2-pre-tcp installs predate allowed_tokens.
  // ADD COLUMN IF NOT EXISTS lets the first daemon boot after upgrade fold
  // the new column into a populated table without operator intervention.
  await client.query(`
    ALTER TABLE pgserve_meta
    ADD COLUMN IF NOT EXISTS allowed_tokens JSONB NOT NULL DEFAULT '[]'::jsonb
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

// ---------------------------------------------------------------------------
// Group 6: TCP bearer-token CRUD
//
// `allowed_tokens` is a JSONB array on pgserve_meta. Each entry is shaped
// `{id, hash, issued_at}` where `hash` is sha256 of the cleartext bearer
// token. Tokens are scoped to the `database_name` row's `fingerprint`; a
// fingerprint without a row cannot have tokens issued (the peer must have
// connected over the Unix socket at least once so its DB exists).
// ---------------------------------------------------------------------------

/**
 * Look up the metadata row for a fingerprint. Returns null if the fingerprint
 * has not yet been provisioned (the peer never connected via Unix socket).
 *
 * @param {{query: Function}} client
 * @param {string} fingerprint — 12 hex chars
 * @returns {Promise<{databaseName: string, fingerprint: string, peerUid: number, allowedTokens: Array<{id: string, hash: string, issued_at: string}>} | null>}
 */
export async function findRowByFingerprint(client, fingerprint) {
  if (!fingerprint) throw new Error('findRowByFingerprint: fingerprint required');
  const r = await client.query(
    `SELECT database_name, fingerprint, peer_uid, allowed_tokens
     FROM pgserve_meta WHERE fingerprint = $1 LIMIT 1`,
    [fingerprint],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    databaseName: row.database_name,
    fingerprint: row.fingerprint,
    peerUid: row.peer_uid,
    allowedTokens: parseTokens(row.allowed_tokens),
  };
}

function parseTokens(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append a hashed bearer token to a fingerprint's allowed list.
 *
 * @param {{query: Function}} client
 * @param {{fingerprint: string, tokenId: string, tokenHash: string}} args
 * @returns {Promise<{databaseName: string}>}
 * @throws if the fingerprint has no pgserve_meta row
 */
export async function addAllowedToken(client, { fingerprint, tokenId, tokenHash }) {
  if (!fingerprint) throw new Error('addAllowedToken: fingerprint required');
  if (!tokenId) throw new Error('addAllowedToken: tokenId required');
  if (!tokenHash) throw new Error('addAllowedToken: tokenHash required');

  const row = await findRowByFingerprint(client, fingerprint);
  if (!row) {
    const err = new Error(
      `addAllowedToken: no pgserve_meta row for fingerprint ${fingerprint}; ` +
      `peer must connect once via Unix socket before tokens can be issued`,
    );
    err.code = 'EUNKNOWNFINGERPRINT';
    throw err;
  }

  const entry = {
    id: tokenId,
    hash: tokenHash,
    issued_at: new Date().toISOString(),
  };
  await client.query(
    `UPDATE pgserve_meta
     SET allowed_tokens = allowed_tokens || $2::jsonb
     WHERE database_name = $1`,
    [row.databaseName, JSON.stringify([entry])],
  );
  return { databaseName: row.databaseName };
}

/**
 * Remove a token by its id from any fingerprint's allowed list. Returns the
 * number of rows affected.
 *
 * @param {{query: Function}} client
 * @param {string} tokenId
 * @returns {Promise<number>}
 */
export async function revokeAllowedToken(client, tokenId) {
  if (!tokenId) throw new Error('revokeAllowedToken: tokenId required');
  // jsonb_path_query_array would be cleaner but isn't on every PG; the array
  // filter via SELECT/UPDATE works on any version >= 12.
  const r = await client.query(
    `UPDATE pgserve_meta
     SET allowed_tokens = COALESCE((
       SELECT jsonb_agg(elem)
       FROM jsonb_array_elements(allowed_tokens) elem
       WHERE elem->>'id' <> $1
     ), '[]'::jsonb)
     WHERE allowed_tokens @> jsonb_build_array(jsonb_build_object('id', $1::text))`,
    [tokenId],
  );
  return r.rowCount ?? r.rows?.length ?? 0;
}

/**
 * Verify a presented bearer-token hash against a fingerprint's allowed list.
 * Returns the matched token id (so audit events can attribute the connection)
 * plus the resolved database name on success, or null if the token is unknown.
 *
 * @param {{query: Function}} client
 * @param {{fingerprint: string, tokenHash: string}} args
 * @returns {Promise<{tokenId: string, databaseName: string} | null>}
 */
export async function verifyToken(client, { fingerprint, tokenHash }) {
  if (!fingerprint) throw new Error('verifyToken: fingerprint required');
  if (!tokenHash) throw new Error('verifyToken: tokenHash required');
  const row = await findRowByFingerprint(client, fingerprint);
  if (!row) return null;
  const match = row.allowedTokens.find((t) => t.hash === tokenHash);
  if (!match) return null;
  return { tokenId: match.id, databaseName: row.databaseName };
}
