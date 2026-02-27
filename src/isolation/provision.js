/**
 * App Schema Provisioner
 *
 * Creates a PostgreSQL schema and role for the given appId, updating the
 * isolation catalog. The operation is:
 *
 * - Idempotent: safe to call multiple times for the same appId
 * - Concurrency-safe: uses a PostgreSQL advisory lock keyed to the appId
 *   so that concurrent calls (in a single process or across a cluster)
 *   serialize on the same lock and only one performs the actual DDL
 *
 * The advisory lock is taken inside a transaction so it is automatically
 * released when the transaction commits or rolls back.
 */

import { normalizeAppId } from './naming.js';
import { getCatalogEntry, upsertCatalogEntry } from './catalog.js';
import { applyDenyByDefault } from './enforcement.js';
import { createLogger } from '../logger.js';

const logger = createLogger({ component: 'isolation:provision' });

/**
 * Compute a stable 64-bit advisory lock key from an appId.
 * Uses a simple djb2-style hash that fits within a signed 32-bit integer
 * (PostgreSQL advisory locks take int4 or int8 arguments).
 *
 * @param {string} appId
 * @returns {number} Lock key
 */
function lockKey(appId) {
  let h = 5381;
  for (let i = 0; i < appId.length; i++) {
    h = ((h << 5) + h + appId.charCodeAt(i)) | 0; // djb2, keep 32-bit
  }
  // Make positive so we stay within int4 range (PostgreSQL advisory lock arg)
  return h >>> 0; // unsigned 32-bit
}

/**
 * Provision a schema and role for the given appId.
 *
 * Steps (all inside a transaction with an advisory lock):
 * 1. Acquire pg_advisory_xact_lock(key) — blocks concurrent calls for same appId
 * 2. Check catalog — if entry exists, return it (already provisioned)
 * 3. CREATE SCHEMA IF NOT EXISTS
 * 4. CREATE ROLE IF NOT EXISTS
 * 5. Upsert catalog entry
 * 6. Return result
 *
 * @param {import('bun').SQL} sql - Bun.sql connection instance
 * @param {string} appId - Application identifier
 * @param {object} [options]
 * @param {number} [options.policyVersion=1] - Policy version to store
 * @param {boolean} [options.enforceDenyByDefault=true] - Apply deny-by-default policy after provisioning
 * @returns {Promise<{ schemaName: string, roleName: string, created: boolean }>}
 */
export async function provisionAppSchema(sql, appId, options = {}) {
  const { schemaName, roleName } = normalizeAppId(appId);
  const policyVersion = options.policyVersion ?? 1;
  const enforceDenyByDefault = options.enforceDenyByDefault ?? true;
  const key = lockKey(appId);

  let created = false;

  await sql.begin(async (tx) => {
    // 1. Acquire advisory lock for this appId (released on transaction end)
    await tx`SELECT pg_advisory_xact_lock(${key}::bigint)`;

    // 2. Check catalog — already provisioned?
    const existing = await getCatalogEntry(tx, appId);
    if (existing) {
      // Already provisioned — nothing to do
      return;
    }

    // 3. CREATE SCHEMA IF NOT EXISTS
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    logger.debug({ appId, schemaName }, 'Schema created');

    // 4. CREATE ROLE IF NOT EXISTS
    // PostgreSQL does not support IF NOT EXISTS for CREATE ROLE before v16,
    // but we guard with a catalog check above so this is safe. We use DO $$ to
    // handle any rare race-condition with a plain catch pattern.
    await tx.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}" NOLOGIN;
        END IF;
      END
      $$
    `);
    logger.debug({ appId, roleName }, 'Role ensured');

    // 5. Upsert catalog entry
    await upsertCatalogEntry(tx, { appId, schemaName, roleName, policyVersion });
    logger.info({ appId, schemaName, roleName }, 'App schema provisioned');

    created = true;
  });

  // 6. Apply deny-by-default policy after the provisioning transaction commits
  //    (outside the transaction so advisory lock is already released)
  if (created && enforceDenyByDefault) {
    await applyDenyByDefault(sql, appId);
  }

  return { schemaName, roleName, created };
}
