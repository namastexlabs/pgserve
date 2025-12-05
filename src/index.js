/**
 * pgserve - Embedded PostgreSQL Server
 *
 * True concurrent connections, zero config, auto-provision databases.
 * Uses embedded-postgres (real PostgreSQL binaries).
 */

// Main exports
export { MultiTenantRouter, startMultiTenantServer } from './router.js';
export { PostgresManager } from './postgres.js';

// Default export
export { startMultiTenantServer as default } from './router.js';
