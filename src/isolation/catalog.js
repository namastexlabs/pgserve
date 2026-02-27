/**
 * Isolation Catalog
 *
 * Manages the `pgserve_isolation_catalog` table which tracks all
 * provisioned schemas and roles. This provides:
 * - Restart-safe state (survives across pgserve restarts)
 * - Cluster-safe state (shared via the same Postgres instance)
 * - Source of truth for schema/role lookups
 *
 * Table columns:
 *   id              SERIAL PRIMARY KEY
 *   name            TEXT UNIQUE NOT NULL   — consumer-defined identifier
 *   schema_name     TEXT NOT NULL
 *   role_name       TEXT NOT NULL
 *   policy_version  INTEGER DEFAULT 1
 *   created_at      TIMESTAMPTZ DEFAULT NOW()
 *   updated_at      TIMESTAMPTZ DEFAULT NOW()
 */

const CATALOG_TABLE = 'pgserve_isolation_catalog';

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
      name           TEXT UNIQUE NOT NULL,
      schema_name    TEXT NOT NULL,
      role_name      TEXT NOT NULL,
      policy_version INTEGER NOT NULL DEFAULT 1,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Retrieve a catalog entry by name.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {string} name - Consumer-defined identifier
 * @returns {Promise<object|null>} Catalog row or null if not found
 */
export async function getCatalogEntry(sql, name) {
  const rows = await sql`
    SELECT * FROM ${sql(CATALOG_TABLE)} WHERE name = ${name} LIMIT 1
  `;
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Insert or update a catalog entry.
 * Uses INSERT ... ON CONFLICT DO UPDATE to avoid duplicates.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {{ name: string, schemaName: string, roleName: string, policyVersion?: number }} entry
 */
export async function upsertCatalogEntry(sql, { name, schemaName, roleName, policyVersion = 1 }) {
  await sql`
    INSERT INTO ${sql(CATALOG_TABLE)} (name, schema_name, role_name, policy_version)
    VALUES (${name}, ${schemaName}, ${roleName}, ${policyVersion})
    ON CONFLICT (name) DO UPDATE SET
      schema_name    = EXCLUDED.schema_name,
      role_name      = EXCLUDED.role_name,
      policy_version = EXCLUDED.policy_version,
      updated_at     = NOW()
  `;
}
