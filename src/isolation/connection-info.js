/**
 * Connection Info
 *
 * Retrieves the connection configuration for a given name from the
 * isolation catalog. This is used by callers that need to open a
 * database connection scoped to a specific schema.
 *
 * Returns null if the name has not been provisioned yet.
 */

import { getCatalogEntry } from './catalog.js';

/**
 * Get connection information from the isolation catalog.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {string} name - Consumer-defined identifier
 * @returns {Promise<{
 *   schemaName: string,
 *   roleName: string,
 *   searchPath: string,
 *   connectionOptions: { searchPath: string }
 * } | null>} Connection info or null if not provisioned
 */
export async function getConnectionInfo(sql, name) {
  const entry = await getCatalogEntry(sql, name);
  if (!entry) return null;

  const { schema_name: schemaName, role_name: roleName } = entry;
  const searchPath = `${schemaName},public`;

  return {
    schemaName,
    roleName,
    searchPath,
    connectionOptions: {
      searchPath,
    },
  };
}
