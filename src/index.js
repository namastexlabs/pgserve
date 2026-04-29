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
export {
  PgserveDaemon,
  startDaemon,
  stopDaemon,
  resolveControlSocketDir,
  resolveControlSocketPath,
  resolvePidLockPath,
  resolveLibpqCompatPath,
  acquirePidLock,
  isProcessAlive,
} from './daemon.js';
export {
  buildDaemonArgs,
  daemonClientOptions,
  ensureDaemon,
  probeDaemon,
  resolveBundledCliBin,
} from './sdk.js';
export {
  derivePackageFingerprint,
  deriveScriptFingerprint,
  fingerprintFromCred,
  findNearestPackageJson,
  readPackageName,
  readPersistFlag,
} from './fingerprint.js';
export {
  hashToken,
  mintToken,
  parseTcpAuth,
} from './tokens.js';

// Default export
export { startMultiTenantServer as default } from './router.js';
