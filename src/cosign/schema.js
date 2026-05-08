/**
 * `pgserve_meta` schema delta — additive verification columns.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Decision P4 (locked): the schema delta is purely additive. Pre-cosign
 * `path`-tier rows continue to work — we add `verified_at`,
 * `verified_identity`, `verified_tier` only. Group 3 (`pgserve provision`)
 * writes these columns when its tier resolution lands in the cosign-signed
 * path; older rows leave them NULL and behave exactly as before.
 *
 * Why a separate module: the underlying `pgserve_meta` table is owned by
 * Group 3 (provision) which lands after Group 4 in Wave 2. We ship the
 * column definitions + idempotent ALTER statements here so Group 3 / 7
 * can call us once their CREATE TABLE has run. Idempotency relies on
 * `ADD COLUMN IF NOT EXISTS` and `ADD CONSTRAINT IF NOT EXISTS` so re-
 * running on an already-migrated database is a no-op.
 */

export const VERIFIED_TIER_VALUES = Object.freeze([
  'path',
  'host_signed',
  'self_signed',
  'cosign_signed',
]);

export const VERIFIED_TIER_CHECK_NAME = 'pgserve_meta_verified_tier_check';

const TIER_LIST_SQL = VERIFIED_TIER_VALUES.map((v) => `'${v}'`).join(', ');

/**
 * Idempotent ALTER statements that add the verification columns to an
 * existing `pgserve_meta` table. Returned as an array so callers can run
 * each statement individually for clearer error reporting.
 *
 * The CHECK constraint is added via DO-block guarded `pg_constraint`
 * lookup because `ADD CONSTRAINT IF NOT EXISTS` is not standardized
 * across all postgres major versions we still support.
 */
export function getMigrationStatements() {
  return [
    'ALTER TABLE pgserve_meta ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ',
    'ALTER TABLE pgserve_meta ADD COLUMN IF NOT EXISTS verified_identity TEXT',
    'ALTER TABLE pgserve_meta ADD COLUMN IF NOT EXISTS verified_tier TEXT',
    [
      'DO $$',
      'BEGIN',
      '  IF NOT EXISTS (',
      '    SELECT 1 FROM pg_constraint',
      `    WHERE conname = '${VERIFIED_TIER_CHECK_NAME}'`,
      '  ) THEN',
      '    EXECUTE $check$',
      `      ALTER TABLE pgserve_meta ADD CONSTRAINT ${VERIFIED_TIER_CHECK_NAME}`,
      `      CHECK (verified_tier IS NULL OR verified_tier IN (${TIER_LIST_SQL}))`,
      '    $check$;',
      '  END IF;',
      'END$$',
    ].join('\n'),
  ];
}

/**
 * Single SQL string variant — convenient for embedding the migration in
 * pg-init scripts that run statements in a transaction.
 */
export function getMigrationSQL() {
  return `${getMigrationStatements().join(';\n\n')};\n`;
}

/**
 * Apply the migration via a node-postgres-compatible client. The client
 * must expose an async `query(sql)` method (matches both `pg.Client` and
 * `pg.PoolClient`). Returns the list of statements executed for caller
 * diagnostics.
 *
 * Statements run sequentially — DO blocks need their own statement
 * boundary and we don't want a single-line failure to masquerade as
 * success on later statements.
 */
export async function applyVerifiedColumns(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('schema: client must expose an async query() method');
  }
  const statements = getMigrationStatements();
  for (const sql of statements) {
    await client.query(sql);
  }
  return statements;
}

/**
 * Convenience predicate — true when the tier value is one the wish
 * accepts. Group 3 (`pgserve provision`) calls this before writing rows.
 */
export function isValidTier(tier) {
  return VERIFIED_TIER_VALUES.includes(tier);
}
