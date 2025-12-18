/**
 * pgserve - Embedded PostgreSQL Server
 *
 * True concurrent connections, zero config, auto-provision databases.
 * Uses embedded-postgres (real PostgreSQL binaries).
 */

// Main exports
export { MultiTenantRouter, startMultiTenantServer } from './router.js';
export { PostgresManager } from './postgres.js';
export { SyncManager } from './sync.js';
export { RestoreManager } from './restore.js';
export { Dashboard } from './dashboard.js';
export { StatsCollector } from './stats-collector.js';
export { StatsDashboard } from './stats-dashboard.js';

// Default export
export { startMultiTenantServer as default } from './router.js';
