/**
 * SQL Policy Enforcement — Deny-by-Default
 *
 * Applies the deny-by-default security policy to a provisioned app schema:
 *
 * 1. REVOKE ALL ON SCHEMA from PUBLIC — no implicit access
 * 2. GRANT USAGE, CREATE ON SCHEMA to the app's role — minimum needed
 * 3. ALTER DEFAULT PRIVILEGES — future tables/sequences owned by the role
 *    are automatically accessible to the role
 * 4. ALTER ROLE ... SET search_path — fixes the default search_path at
 *    role level so the app never accidentally touches another schema
 *
 * All operations are idempotent — safe to call multiple times.
 * Uses sql.unsafe() because schema/role names are identifiers, not parameters.
 */

import { normalizeAppId } from './naming.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ component: 'isolation:enforcement' });

/**
 * Apply deny-by-default SQL policy to the given app's schema.
 *
 * Must be called AFTER the schema and role already exist (i.e., after
 * provisionAppSchema).  It is safe to call multiple times (idempotent).
 *
 * @param {import('bun').SQL} sql - Bun.sql admin connection
 * @param {string} appId - Application identifier
 * @returns {Promise<void>}
 */
export async function applyDenyByDefault(sql, appId) {
  const { schemaName, roleName } = normalizeAppId(appId);

  // 1. Revoke public access — deny-by-default baseline
  await sql.unsafe(`REVOKE ALL ON SCHEMA "${schemaName}" FROM PUBLIC`);
  logger.debug({ appId, schemaName }, 'Revoked all privileges on schema from PUBLIC');

  // 2. Grant minimum necessary to the app's own role
  await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA "${schemaName}" TO "${roleName}"`);
  logger.debug({ appId, schemaName, roleName }, 'Granted USAGE, CREATE on schema to role');

  // 3. Default privileges for future tables created by this role in this schema
  await sql.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE "${roleName}" IN SCHEMA "${schemaName}"
    GRANT ALL ON TABLES TO "${roleName}"
  `);
  logger.debug({ appId, schemaName, roleName }, 'Set default privileges for tables');

  // 4. Default privileges for future sequences created by this role in this schema
  await sql.unsafe(`
    ALTER DEFAULT PRIVILEGES FOR ROLE "${roleName}" IN SCHEMA "${schemaName}"
    GRANT ALL ON SEQUENCES TO "${roleName}"
  `);
  logger.debug({ appId, schemaName, roleName }, 'Set default privileges for sequences');

  // 5. Fix search_path at role level — prevents cross-schema leakage
  await sql.unsafe(`ALTER ROLE "${roleName}" SET search_path TO "${schemaName}"`);
  logger.debug({ appId, schemaName, roleName }, 'Fixed search_path at role level');

  logger.info({ appId, schemaName, roleName }, 'Deny-by-default policy applied');
}
