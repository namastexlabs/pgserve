/**
 * Isolation Catalog
 *
 * Manages the `pgserve_app_isolation_catalog` table which tracks all
 * provisioned app schemas and roles. This provides:
 * - Restart-safe state (survived across pgserve restarts)
 * - Cluster-safe state (shared via the same Postgres instance)
 * - Source of truth for schema/role lookups
 *
 * Table columns:
 *   id              SERIAL PRIMARY KEY
 *   app_id          TEXT UNIQUE NOT NULL
 *   schema_name     TEXT NOT NULL
 *   role_name       TEXT NOT NULL
 *   policy_version  INTEGER DEFAULT 1
 *   created_at      TIMESTAMPTZ DEFAULT NOW()
 *   updated_at      TIMESTAMPTZ DEFAULT NOW()
 */

const CATALOG_TABLE = 'pgserve_app_isolation_catalog';

/**
 * Initialize the catalog table (CREATE TABLE IF NOT EXISTS).
 * Safe to call multiple times — fully idempotent.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 */
export async function initCatalog(sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${CATALOG_TABLE} (
      id             SERIAL PRIMARY KEY,
      app_id         TEXT UNIQUE NOT NULL,
      schema_name    TEXT NOT NULL,
      role_name      TEXT NOT NULL,
      policy_version INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Retrieve a catalog entry by appId.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {string} appId - Application identifier
 * @returns {Promise<object|null>} Catalog row or null if not found
 */
export async function getCatalogEntry(sql, appId) {
  const rows = await sql`
    SELECT * FROM ${sql(CATALOG_TABLE)} WHERE app_id = ${appId} LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Insert or update a catalog entry for the given appId.
 * Uses INSERT ... ON CONFLICT DO UPDATE to avoid duplicates.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {{ appId: string, schemaName: string, roleName: string, policyVersion?: number }} entry
 */
export async function upsertCatalogEntry(sql, { appId, schemaName, roleName, policyVersion = 1 }) {
  await sql`
    INSERT INTO ${sql(CATALOG_TABLE)} (app_id, schema_name, role_name, policy_version)
    VALUES (${appId}, ${schemaName}, ${roleName}, ${policyVersion})
    ON CONFLICT (app_id) DO UPDATE SET
      schema_name    = EXCLUDED.schema_name,
      role_name      = EXCLUDED.role_name,
      policy_version = EXCLUDED.policy_version,
      updated_at     = NOW()
  `;
}
