/**
 * pgserve tenancy — fingerprint-to-database name resolution + kill-switch.
 *
 * Group 4 wires the kernel-rooted fingerprint (Group 3) to the per-tenant
 * Postgres database. Each `(fingerprint, name)` pair maps deterministically
 * to a database called `app_<sanitized-name>_<12hex>` (≤63 chars, the PG
 * identifier limit).
 *
 * Sanitization rules (per WISH §Group 4):
 *   - non-[a-z0-9] runs collapse to a single `_`
 *   - lowercased
 *   - truncated to 30 chars (so `app_<30>_<12>` ≤ 47 chars, well under 63)
 *
 * The kill switch (`PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`) is read
 * once per process via `isFingerprintEnforcementDisabled()`. The daemon
 * logs a deprecation warning at boot when the env var is observed; the
 * audit event `enforcement_kill_switch_used` fires on every bypassed
 * cross-fingerprint connection.
 */

export const KILL_SWITCH_ENV = 'PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT';

// `sanitizeName` and `resolveTenantDatabaseName` were removed in the autopg
// cutover (Group 4) along with their only callers in the deleted proxy
// stack. Group 5's `autopg create-app` will reintroduce a per-app analogue
// keyed off the `autopg_apps.app_name` column rather than fingerprints.

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isFingerprintEnforcementDisabled(env = process.env) {
  return env[KILL_SWITCH_ENV] === '1';
}
