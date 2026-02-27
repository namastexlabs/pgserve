/**
 * Schema Provisioner
 *
 * Creates a PostgreSQL schema and role with the given names, updating the
 * isolation catalog. The operation is:
 *
 * - Idempotent: safe to call multiple times for the same name
 * - Concurrency-safe: uses a PostgreSQL advisory lock keyed to the name
 *   so that concurrent calls (in a single process or across a cluster)
 *   serialize on the same lock and only one performs the actual DDL
 *
 * The advisory lock is taken inside a transaction so it is automatically
 * released when the transaction commits or rolls back.
 */

import { getCatalogEntry, upsertCatalogEntry } from './catalog.js';
import { applyDenyByDefault } from './enforcement.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ component: 'isolation:provision' });

/**
 * Compute a stable advisory lock key from a string.
 * Uses a simple djb2-style hash that fits within a signed 32-bit integer
 * (PostgreSQL advisory locks take int4 or int8 arguments).
 *
 * @param {string} str
 * @returns {number} Lock key
 */
function lockKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0; // djb2, keep 32-bit
  }
  return h >>> 0; // unsigned 32-bit
}

/**
 * Provision a schema and role.
 *
 * The caller provides the exact schema and role names — pgserve does not
 * impose any naming convention.
 *
 * Steps (all inside a transaction with an advisory lock):
 * 1. Acquire pg_advisory_xact_lock(key) — blocks concurrent calls for same name
 * 2. Check catalog — if entry exists, return it (already provisioned)
 * 3. CREATE SCHEMA IF NOT EXISTS
 * 4. CREATE ROLE IF NOT EXISTS
 * 5. Upsert catalog entry
 * 6. Return result
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {{ name: string, schemaName: string, roleName: string }} target
 * @param {object} [options]
 * @param {number} [options.policyVersion=1] - Policy version to store
 * @param {boolean} [options.enforceDenyByDefault=true] - Apply deny-by-default policy after provisioning
 * @returns {Promise<{ schemaName: string, roleName: string, created: boolean }>}
 */
export async function provisionSchema(sql, { name, schemaName, roleName }, options = {}) {
  const policyVersion = options.policyVersion ?? 1;
  const enforceDenyByDefault = options.enforceDenyByDefault ?? true;
  const key = lockKey(name);

  let created = false;

  await sql.begin(async (tx) => {
    // 1. Acquire advisory lock (released on transaction end)
    await tx`SELECT pg_advisory_xact_lock(${key}::bigint)`;

    // 2. Check catalog — already provisioned?
    const existing = await getCatalogEntry(tx, name);
    if (existing) {
      return;
    }

    // 3. CREATE SCHEMA IF NOT EXISTS
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    logger.debug({ name, schemaName }, 'Schema created');

    // 4. CREATE ROLE IF NOT EXISTS
    await tx.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}" NOLOGIN;
        END IF;
      END
      $$
    `);
    logger.debug({ name, roleName }, 'Role ensured');

    // 5. Upsert catalog entry
    await upsertCatalogEntry(tx, { name, schemaName, roleName, policyVersion });
    logger.info({ name, schemaName, roleName }, 'Schema provisioned');

    created = true;
  });

  // 6. Apply deny-by-default policy after the provisioning transaction commits
  if (created && enforceDenyByDefault) {
    await applyDenyByDefault(sql, { schemaName, roleName });
  }

  return { schemaName, roleName, created };
}
