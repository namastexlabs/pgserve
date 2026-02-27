/**
 * SQL Policy Enforcement — Deny-by-Default
 *
 * Applies the deny-by-default security policy to a provisioned schema:
 *
 * 1. REVOKE ALL ON SCHEMA from PUBLIC — no implicit access
 * 2. GRANT USAGE, CREATE ON SCHEMA to the role — minimum needed
 * 3. ALTER DEFAULT PRIVILEGES — future tables/sequences owned by the role
 *    are automatically accessible to the role
 * 4. ALTER ROLE ... SET search_path — fixes the default search_path at
 *    role level so queries never accidentally touch another schema
 *
 * All operations are idempotent — safe to call multiple times.
 * Uses sql.unsafe() because schema/role names are identifiers, not parameters.
 */

import { validateIdentifier } from './identifiers.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ component: 'isolation:enforcement' });

/**
 * Apply deny-by-default SQL policy to the given schema.
 *
 * Must be called AFTER the schema and role already exist (i.e., after
 * provisionSchema). It is safe to call multiple times (idempotent).
 *
 * @param {import('bun').SQL} sql - Bun.sql admin connection
 * @param {{ schemaName: string, roleName: string }} target
 * @returns {Promise<void>}
 */
export async function applyDenyByDefault(sql, { schemaName, roleName }) {
  validateIdentifier(schemaName, 'schemaName');
  validateIdentifier(roleName, 'roleName');

  await sql.begin(async (tx) => {
    // 1. Revoke public access — deny-by-default baseline
    await tx.unsafe(`REVOKE ALL ON SCHEMA "${schemaName}" FROM PUBLIC`);

    // 2. Grant minimum necessary to the role
    await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA "${schemaName}" TO "${roleName}"`);

    // 3. Default privileges for future tables created by this role
    await tx.unsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${roleName}" IN SCHEMA "${schemaName}"
      GRANT ALL ON TABLES TO "${roleName}"
    `);

    // 4. Default privileges for future sequences created by this role
    await tx.unsafe(`
      ALTER DEFAULT PRIVILEGES FOR ROLE "${roleName}" IN SCHEMA "${schemaName}"
      GRANT ALL ON SEQUENCES TO "${roleName}"
    `);

    // 5. Fix search_path at role level
    await tx.unsafe(`ALTER ROLE "${roleName}" SET search_path TO "${schemaName}"`);
  });

  logger.info({ schemaName, roleName }, 'Deny-by-default policy applied');
}
