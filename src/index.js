/**
 * autopg / pgserve - Embedded PostgreSQL Server
 *
 * Post-cutover: control plane only — never in the byte path.
 * Per-app SCRAM credentials + native postgres connection contract
 * replace the wrapper-proxy modules deleted in autopg Group 4.
 */

// Main exports
export { PostgresManager } from './postgres.js';
export { SyncManager } from './sync.js';
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
  acquirePidLock,
  isProcessAlive,
} from './daemon.js';
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
