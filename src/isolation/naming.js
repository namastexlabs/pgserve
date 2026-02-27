/**
 * Isolation naming helpers
 *
 * Converts arbitrary appId strings into safe PostgreSQL identifiers
 * for schema names and role names.
 *
 * Rules:
 * - Lowercase all characters
 * - Replace hyphens, spaces, and other non-alphanumeric chars with underscores
 * - Collapse consecutive underscores into a single underscore
 * - Strip leading/trailing underscores from the normalized part
 * - Prefix schema with "app_" and role with "app_" + normalized + "_role"
 *
 * Examples:
 *   "my-app"         -> { schemaName: "app_my_app",    roleName: "app_my_app_role" }
 *   "MYAPP"          -> { schemaName: "app_myapp",     roleName: "app_myapp_role" }
 *   "khal-backend"   -> { schemaName: "app_khal_backend", roleName: "app_khal_backend_role" }
 *   "my--app__test"  -> { schemaName: "app_my_app_test",  roleName: "app_my_app_test_role" }
 */

/**
 * Normalize an appId into a safe PostgreSQL identifier fragment.
 * @param {string} appId - Raw application identifier
 * @returns {{ schemaName: string, roleName: string }}
 */
export function normalizeAppId(appId) {
  if (!appId || typeof appId !== 'string') {
    throw new Error('appId must be a non-empty string');
  }

  const normalized = appId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric runs with single underscore
    .replace(/_+/g, '_')          // Collapse consecutive underscores
    .replace(/^_|_$/g, '');       // Strip leading/trailing underscores

  if (!normalized) {
    throw new Error(`appId '${appId}' normalizes to an empty string`);
  }

  return {
    schemaName: `app_${normalized}`,
    roleName: `app_${normalized}_role`,
  };
}
