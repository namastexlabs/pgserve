/**
 * `autopg_meta` table bootstrap.
 *
 * pgserve singleton (v2.6) — `autopg-distribution-cutover-finalize`
 * wish, Group 3 (`pgserve create-app` + manifest LOCK 1).
 *
 * Source-of-truth split (per wish Decision #2 / G3 deliverable 4):
 *
 *   `autopg_meta` is the single source of truth for "which apps are
 *   registered with this pgserve instance + what cosign trust roots are
 *   locked at create-app time." The per-consumer manifest file at
 *   `~/.autopg/<sanitized-slug>/manifest.json` (and the sibling
 *   `admin.json`) are derived caches; on divergence, the table wins.
 *
 *   The `--fix` mutation modes that would regenerate the cache files
 *   from the table are NOT implemented in v2.4 read-only V1
 *   (src/commands/doctor.js:440-442 prints "--fix tiered modes are not
 *   implemented in v2.4"). Until those land, the cache-recovery story is
 *   manual: operator deletes the per-consumer dir + re-runs
 *   `pgserve create-app <slug>`. The verb is idempotent and preserves
 *   the locked_roots already on the row (idempotent re-run touches
 *   `last_updated` ONLY).
 *
 * Why a separate table from `pgserve_meta`: different lifecycle.
 *   `pgserve_meta` is per-database (provision/gc cohort, fingerprint as
 *   PK). `autopg_meta` is per-consumer-app (slug as PK), and an app can
 *   exist before any of its DBs do. Splitting the tables keeps each
 *   bootstrap genuinely additive + lets the wish Group 4/5 work
 *   (per-consumer doctor surface) reach for autopg_meta without
 *   crossing into pgserve_meta's invariants.
 *
 * Idempotency: every statement uses `IF NOT EXISTS` (table, indexes).
 * Re-running on an already-bootstrapped database is a no-op.
 */

export const AUTOPG_META_TABLE = 'autopg_meta';

/**
 * Base columns owned by this module.
 *
 *   - slug:           PRIMARY KEY — the sanitized consumer slug
 *                     (sanitizeSlug from src/provision/db-naming.js)
 *   - manifest_path:  NOT NULL — absolute path to the cache manifest
 *                     file at ~/.autopg/<slug>/manifest.json
 *   - locked_roots:   NOT NULL — JSONB array shaped like
 *                     TRUSTED_IDENTITIES entries, frozen-at-create
 *   - created_at:     NOT NULL DEFAULT now() — set on insert
 *   - last_updated:   NOT NULL DEFAULT now() — touched by every
 *                     create-app re-run; locked_roots stays untouched
 */
export const AUTOPG_META_COLUMNS = Object.freeze([
  'slug',
  'manifest_path',
  'locked_roots',
  'created_at',
  'last_updated',
]);

// Schema-qualified name. The doctor / verifier read paths probe
// `to_regclass('public.autopg_meta')`; an unqualified CREATE TABLE
// could land in a non-public schema if a non-default search_path is
// configured on the active role, leaving subsequent reads unable to
// find it. Match the qualification convention pgserve_meta uses.
const QUALIFIED = `public.${AUTOPG_META_TABLE}`;

/**
 * Idempotent statements that CREATE the table + supporting indexes.
 * Returned as an array so callers can run each one individually for
 * clear error reporting (mirrors src/schema/pgserve-meta.js shape).
 */
export function getBootstrapStatements() {
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${QUALIFIED} (`,
      '  slug          TEXT        PRIMARY KEY,',
      '  manifest_path TEXT        NOT NULL,',
      '  locked_roots  JSONB       NOT NULL,',
      '  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),',
      '  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now()',
      ')',
    ].join('\n'),
    `CREATE INDEX IF NOT EXISTS ${AUTOPG_META_TABLE}_last_updated_idx ON ${QUALIFIED} (last_updated)`,
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
export async function bootstrapAutopgMeta(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('bootstrapAutopgMeta: client must expose an async query() method');
  }
  const statements = getBootstrapStatements();
  for (const sql of statements) {
    await client.query(sql);
  }
  return statements;
}

/**
 * Predicate the doctor / verify read paths can call before deciding
 * whether to query the table. Callers pass the result of
 * `SELECT to_regclass('public.autopg_meta') IS NOT NULL`.
 */
export function tableExistsFromRegclass(toRegclassResult) {
  return toRegclassResult === true;
}
