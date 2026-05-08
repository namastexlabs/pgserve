/**
 * `pgserve_meta` table bootstrap.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3
 * (foundation for `pgserve provision` and `pgserve gc`).
 *
 * Schema rationale (Decision P4 — additive across the cohort):
 *
 *   `pgserve_meta` is the single source of truth for "which postgres
 *   databases on this host belong to a known pgserve consumer."
 *   `pgserve provision` writes a row when it idempotently CREATEs a DB +
 *   role for a fingerprint. `pgserve gc` scans the table and DROPs DBs
 *   whose `last_used_at` is older than the configured stale threshold or
 *   whose source_path no longer exists. The cosign verify columns
 *   (`verified_at`, `verified_identity`, `verified_tier`) are layered on
 *   top via `src/cosign/schema.js#applyVerifiedColumns`; they ALTER this
 *   table after CREATE.
 *
 * Why a separate module from cosign/schema.js: cosign owns the
 * verification *delta*; this module owns the *base* table. Splitting
 * them keeps the cosign migration genuinely additive (it's a no-op on
 * fresh DBs that haven't bootstrapped, exactly as documented in
 * cosign-meta-migration.js).
 *
 * Idempotency: every statement uses `IF NOT EXISTS` (table, columns,
 * indexes). Re-running on an already-bootstrapped database is a no-op.
 */

export const PGSERVE_META_TABLE = 'pgserve_meta';

/**
 * Base columns owned by this module. Cosign columns are owned by
 * src/cosign/schema.js and ALTERed in afterwards.
 */
export const PGSERVE_META_COLUMNS = Object.freeze([
  'fingerprint',
  'database_name',
  'role_name',
  'publisher',
  'source_path',
  'created_at',
  'last_used_at',
]);

/**
 * Idempotent statements that CREATE the table + supporting indexes.
 * Returned as an array so callers can run each one individually for
 * clear error reporting (mirrors cosign/schema.js#getMigrationStatements).
 *
 * Constraints:
 *   - fingerprint:    PRIMARY KEY — the package.json sha256 fingerprint
 *   - database_name:  UNIQUE NOT NULL — guards against accidental dupes
 *   - role_name:      NOT NULL — every provisioned DB has a paired role
 *   - publisher:      nullable — older path-tier installs may have none
 *   - source_path:    nullable — fallback fingerprint may not have one
 *   - created_at:     NOT NULL DEFAULT now() — set on insert
 *   - last_used_at:   NOT NULL DEFAULT now() — touched by provision; gc
 *                     uses it as the staleness signal
 */
export function getBootstrapStatements() {
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${PGSERVE_META_TABLE} (`,
      '  fingerprint   TEXT        PRIMARY KEY,',
      '  database_name TEXT        NOT NULL UNIQUE,',
      '  role_name     TEXT        NOT NULL,',
      '  publisher     TEXT,',
      '  source_path   TEXT,',
      '  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()',
      ')',
    ].join('\n'),
    `CREATE INDEX IF NOT EXISTS ${PGSERVE_META_TABLE}_last_used_at_idx ON ${PGSERVE_META_TABLE} (last_used_at)`,
    `CREATE INDEX IF NOT EXISTS ${PGSERVE_META_TABLE}_publisher_idx ON ${PGSERVE_META_TABLE} (publisher)`,
  ];
}

/**
 * Single SQL string variant — convenient for embedding the bootstrap in
 * a transaction or pg-init script.
 */
export function getBootstrapSQL() {
  return `${getBootstrapStatements().join(';\n\n')};\n`;
}

/**
 * Apply the bootstrap via a node-postgres-compatible client. The client
 * must expose an async `query(sql)` method (matches both `pg.Client` and
 * `pg.PoolClient`). Returns the list of statements executed.
 *
 * Statements run sequentially so a failure on the index half doesn't
 * masquerade as success after the table half ran.
 */
export async function bootstrapPgserveMeta(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('bootstrapPgserveMeta: client must expose an async query() method');
  }
  const statements = getBootstrapStatements();
  for (const sql of statements) {
    await client.query(sql);
  }
  return statements;
}

/**
 * Predicate the upgrade pipeline calls before deciding whether to run
 * the cosign-verify ALTER chain. We avoid loading pg here — callers pass
 * the result of `SELECT to_regclass('public.pgserve_meta') IS NOT NULL`.
 */
export function tableExistsFromRegclass(toRegclassResult) {
  return toRegclassResult === true;
}
