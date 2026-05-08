/**
 * Cohort-shared pm2 launch builder for the canonical-pgserve-pm2-supervision
 * wish (Group 1).
 *
 * Exports:
 *   PM2_HARDENED_DEFAULTS — baseline hardening values pinned in the wish
 *   SERVICE_MEMORY_LIMITS — per-service maxMemoryRestart map
 *   buildPm2StartArgs(serviceName, opts) — factory returning the argv passed
 *     to `pm2 ...`
 *
 * Per Decision 3 of the wish, the constants stay duplicated across
 * `autopg`, `genie`, and `omni` rather than introducing a shared package —
 * the values are pinned here and copied verbatim into the genie + omni
 * installers.
 *
 * Note on the autopg daemon (`autopg-server`): its own pm2 args are still
 * built inside `src/cli-install.cjs` with a higher restart budget and a
 * larger memory ceiling, because postgres specifics demand more headroom
 * (see PR #57 review notes). The values exported here are the cohort
 * baseline used by the companion `autopg-ui` process and by the cross-repo
 * services (`genie-serve`, `omni-api`, `omni-nats`).
 */

import path from 'node:path';

export const PM2_HARDENED_DEFAULTS = Object.freeze({
  maxRestarts: 10,
  restartDelayMs: 5000,
  killTimeoutMs: 20000,
  logDateFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
  // pm2 launches both genie and omni binaries via `#!/usr/bin/env bun`
  // shebangs. `--interpreter bun` triggers pm2's ESM/require crash on
  // top-level await; shebang resolution side-steps the issue.
  // Empirically validated 2026-04-30 (Decision 4 of the wish).
  interpreter: 'none',
});

export const SERVICE_MEMORY_LIMITS = Object.freeze({
  'autopg-server': '2G',
  'autopg-ui': '256M',
  'genie-serve': '2G',
  'omni-api': '2G',
  'omni-nats': '1G',
});

export const DEFAULT_MAX_MEMORY = '2G';

const VALID_SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Resolve the maxMemoryRestart string for a service. Honors caller override
 * first, then SERVICE_MEMORY_LIMITS, then DEFAULT_MAX_MEMORY.
 */
export function resolveMaxMemory(serviceName, override) {
  if (override) return override;
  return SERVICE_MEMORY_LIMITS[serviceName] || DEFAULT_MAX_MEMORY;
}

/**
 * Build the argv to register a long-lived service under pm2.
 *
 * @param {string} serviceName — pm2 process name (also used in default log
 *   filenames). Must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`.
 * @param {object} opts
 * @param {string} opts.scriptPath — script pm2 invokes
 * @param {string} opts.logsDir — directory for `<name>-out.log` /
 *   `<name>-error.log`
 * @param {string[]} [opts.scriptArgs] — args passed after `--` to the script
 * @param {string} [opts.maxMemoryRestart] — override the per-service default
 *   (e.g. `4G` on big-iron hosts)
 * @param {object} [opts.overrides] — override individual hardening values
 *   (`maxRestarts`, `restartDelayMs`, `killTimeoutMs`, `logDateFormat`,
 *   `interpreter`)
 * @returns {string[]} args to pass to `pm2`
 */
export function buildPm2StartArgs(serviceName, opts) {
  if (typeof serviceName !== 'string' || !VALID_SERVICE_NAME.test(serviceName)) {
    throw new TypeError(
      `pm2-args: serviceName must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/; got ${JSON.stringify(serviceName)}`,
    );
  }
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('pm2-args: opts is required');
  }
  if (typeof opts.scriptPath !== 'string' || opts.scriptPath.length === 0) {
    throw new TypeError('pm2-args: opts.scriptPath must be a non-empty string');
  }
  if (typeof opts.logsDir !== 'string' || opts.logsDir.length === 0) {
    throw new TypeError('pm2-args: opts.logsDir must be a non-empty string');
  }

  const overrides = opts.overrides || {};
  const maxRestarts = overrides.maxRestarts ?? PM2_HARDENED_DEFAULTS.maxRestarts;
  const restartDelayMs = overrides.restartDelayMs ?? PM2_HARDENED_DEFAULTS.restartDelayMs;
  const killTimeoutMs = overrides.killTimeoutMs ?? PM2_HARDENED_DEFAULTS.killTimeoutMs;
  const logDateFormat = overrides.logDateFormat ?? PM2_HARDENED_DEFAULTS.logDateFormat;
  const interpreter = overrides.interpreter ?? PM2_HARDENED_DEFAULTS.interpreter;
  const maxMemoryRestart = resolveMaxMemory(serviceName, opts.maxMemoryRestart);

  const argv = [
    'start',
    opts.scriptPath,
    '--name', serviceName,
    '--interpreter', interpreter,
    '--max-restarts', String(maxRestarts),
    '--restart-delay', String(restartDelayMs),
    '--max-memory-restart', maxMemoryRestart,
    '--kill-timeout', String(killTimeoutMs),
    '--log-date-format', logDateFormat,
    '--output', path.join(opts.logsDir, `${serviceName}-out.log`),
    '--error', path.join(opts.logsDir, `${serviceName}-error.log`),
  ];

  const scriptArgs = Array.isArray(opts.scriptArgs) ? opts.scriptArgs : [];
  if (scriptArgs.length > 0) {
    argv.push('--', ...scriptArgs);
  }
  return argv;
}
