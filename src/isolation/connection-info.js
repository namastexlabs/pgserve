/**
 * App Connection Info
 *
 * Retrieves the connection configuration for a given appId from the
 * isolation catalog. This is used by callers that need to open a
 * database connection scoped to a specific app's schema.
 *
 * Returns null if the appId has not been provisioned yet.
 */

import { getCatalogEntry } from './catalog.js';

/**
 * Get connection information for an app from the isolation catalog.
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {string} appId - Application identifier
 * @returns {Promise<{
 *   schemaName: string,
 *   roleName: string,
 *   searchPath: string,
 *   connectionOptions: { searchPath: string }
 * } | null>} Connection info or null if not provisioned
 */
export async function getAppConnectionInfo(sql, appId) {
  const entry = await getCatalogEntry(sql, appId);
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
