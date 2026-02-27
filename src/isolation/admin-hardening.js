/**
 * Connection Hardening — Admin Role Rejection
 *
 * Prevents admin/superuser credentials from being used in isolated traffic.
 * Connections must use the designated role — never the postgres superuser
 * or any other role with superuser privileges.
 *
 * API:
 *   isAdminRole(sql, roleName)              → boolean
 *   validateConnection(sql, name, user)     → { valid, reason? }
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
    return false;
  }
  return rows[0].rolsuper === true;
}

/**
 * Validate that a connection user is authorised to access the given schema.
 *
 * Rules (checked in order):
 * 1. The name must be provisioned (exist in the isolation catalog).
 * 2. The connectionUser must NOT be a superuser role.
 * 3. The connectionUser must match the expected role name exactly.
 *
 * @param {import('bun').SQL} sql - Bun.sql admin connection
 * @param {string} name - Consumer-defined identifier
 * @param {string} connectionUser - The role/user attempting to connect
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateConnection(sql, name, connectionUser) {
  const entry = await getCatalogEntry(sql, name);
  if (!entry) {
    const reason = `'${name}' has not been provisioned`;
    logger.warn({ name, connectionUser, reason }, 'Connection rejected');
    return { valid: false, reason };
  }

  const adminCheck = await isAdminRole(sql, connectionUser);
  if (adminCheck) {
    const reason = `Role '${connectionUser}' has superuser privileges and cannot be used for isolated connections`;
    logger.warn({ name, connectionUser, reason }, 'Admin role rejected');
    return { valid: false, reason };
  }

  const expectedRole = entry.role_name;
  if (connectionUser !== expectedRole) {
    const reason = `Role '${connectionUser}' does not match expected role '${expectedRole}' for '${name}'`;
    logger.warn({ name, connectionUser, expectedRole, reason }, 'Wrong role rejected');
    return { valid: false, reason };
  }

  logger.debug({ name, connectionUser }, 'Connection validated');
  return { valid: true };
}
