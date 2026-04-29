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

const NAME_TRUNCATE = 30;
const MAX_DB_IDENT = 63;

/**
 * Collapse non-alphanumeric runs to a single `_`, lowercase, truncate.
 *
 * Empty or null names fall back to `'anon'` so we always emit a usable
 * database identifier — a peer with no resolvable package name still
 * deserves a tenant DB, just one that visibly says "anonymous".
 *
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const raw = (typeof name === 'string' ? name : '').toLowerCase();
  const collapsed = raw.replace(/[^a-z0-9]+/g, '_');
  if (!collapsed || collapsed === '_') return 'anon';
  return collapsed.slice(0, NAME_TRUNCATE);
}

/**
 * Build the canonical per-tenant database name `app_<sanitized>_<fingerprint>`.
 *
 * Throws if fingerprint is not the documented 12 lowercase-hex blob —
 * any caller that managed to slip a malformed fingerprint through deserves
 * a loud failure rather than a silent identifier mismatch later.
 *
 * @param {{name: string|null|undefined, fingerprint: string}} args
 * @returns {string}
 */
export function resolveTenantDatabaseName({ name, fingerprint }) {
  if (!/^[0-9a-f]{12}$/.test(fingerprint || '')) {
    throw new Error(`resolveTenantDatabaseName: fingerprint must be 12 hex chars, got "${fingerprint}"`);
  }
  const sanitized = sanitizeName(name);
  const ident = `app_${sanitized}_${fingerprint}`;
  if (ident.length > MAX_DB_IDENT) {
    // Truncation already bounds sanitized to 30; the fingerprint adds 12;
    // the prefix `app_` adds 4 + two underscores = 48. We are safe by
    // construction, but assert anyway: a future change to NAME_TRUNCATE
    // must not silently produce >63-char identifiers.
    throw new Error(`resolveTenantDatabaseName: identifier "${ident}" exceeds ${MAX_DB_IDENT} chars`);
  }
  return ident;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isFingerprintEnforcementDisabled(env = process.env) {
  return env[KILL_SWITCH_ENV] === '1';
}
