/**
 * Connection Hardening — Admin Role Rejection
 *
 * Prevents admin/superuser credentials from being used in app traffic.
 * App connections must use the app's own role — never the postgres superuser
 * or any other role with superuser privileges.
 *
 * API:
 *   isAdminRole(sql, roleName)              → boolean
 *   validateAppConnection(sql, appId, user) → { valid, reason? }
 */

import { getCatalogEntry } from './catalog.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ component: 'isolation:admin-hardening' });

/**
 * Check whether a PostgreSQL role has superuser privileges.
 *
 * Returns false for roles that do not exist (unknown roles are not superusers).
 *
 * @param {import('bun').SQL} sql - Bun.sql admin connection
 * @param {string} roleName - Role name to check
 * @returns {Promise<boolean>}
 */
export async function isAdminRole(sql, roleName) {
  const rows = await sql`
    SELECT rolsuper FROM pg_roles WHERE rolname = ${roleName} LIMIT 1
  `;
  if (rows.length === 0) {
    // Role does not exist — not a superuser
    return false;
  }
  return rows[0].rolsuper === true;
}

/**
 * Validate that a connection user is authorised to access the given app.
 *
 * Rules (checked in order):
 * 1. The appId must be provisioned (exist in the isolation catalog).
 * 2. The connectionUser must NOT be a superuser role.
 * 3. The connectionUser must match the app's expected role name exactly.
 *
 * @param {import('bun').SQL} sql - Bun.sql admin connection
 * @param {string} appId - Application identifier
 * @param {string} connectionUser - The role/user attempting to connect
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateAppConnection(sql, appId, connectionUser) {
  // 1. Resolve the catalog entry for this appId
  const entry = await getCatalogEntry(sql, appId);
  if (!entry) {
    const reason = `App '${appId}' has not been provisioned`;
    logger.warn({ appId, connectionUser, reason }, 'App connection rejected');
    return { valid: false, reason };
  }

  // 2. Reject superuser roles — admin credentials must never flow through app paths
  const adminCheck = await isAdminRole(sql, connectionUser);
  if (adminCheck) {
    const reason = `Role '${connectionUser}' has superuser privileges and cannot be used for app connections`;
    logger.warn({ appId, connectionUser, reason }, 'Admin role rejected for app connection');
    return { valid: false, reason };
  }

  // 3. Ensure the connection user matches the app's role exactly
  const expectedRole = entry.role_name;
  if (connectionUser !== expectedRole) {
    const reason = `Role '${connectionUser}' does not match expected role '${expectedRole}' for app '${appId}'`;
    logger.warn({ appId, connectionUser, expectedRole, reason }, 'Wrong role rejected for app connection');
    return { valid: false, reason };
  }

  logger.debug({ appId, connectionUser }, 'App connection validated');
  return { valid: true };
}
