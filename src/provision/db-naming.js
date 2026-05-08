/**
 * Database + role naming for `pgserve provision`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * Postgres identifiers max out at NAMEDATALEN-1 = 63 chars (default
 * build). Our naming has to:
 *   1. Be deterministic: same fingerprint → same name forever, so a
 *      re-run of `pgserve provision` is idempotent and `pgserve gc`
 *      can correlate `pg_database` rows back to `pgserve_meta` rows.
 *   2. Be readable: include enough of the publisher slug that an
 *      operator looking at `\l` in psql can figure out which consumer
 *      a database belongs to.
 *   3. Stay under 63 chars even when the publisher is long.
 *   4. Avoid postgres reserved keywords and quoting requirements
 *      (lowercase + [a-z0-9_] only).
 *
 * Layout (≤63 chars):
 *
 *   pgserve_<publisher-slug>_<fingerprint-hex-12>
 *
 *   - prefix:           "pgserve_" (8 chars) — fixed, used by gc to
 *                       find candidate orphans without scanning every
 *                       postgres DB.
 *   - publisher-slug:   sanitized + truncated package.json name /
 *                       pgserve.publisher; max 41 chars.
 *   - fingerprint hex:  first 12 hex chars of the fingerprint. Plenty
 *                       of entropy to avoid collisions across consumers
 *                       on the same host.
 *
 * Role name uses the same identifier with `_role` suffix. Because the
 * publisher slug is already truncated to fit the database name, we
 * recompute the role-side budget so the role also stays ≤63 chars.
 *
 * Pure function: no fs / network / pg.
 */

const POSTGRES_MAX_IDENTIFIER = 63;
const PREFIX = 'pgserve_';
const FINGERPRINT_HEX_LEN = 12;
const ROLE_SUFFIX = '_role';

/**
 * Lowercase + replace any char that's not [a-z0-9] with '_'. Collapses
 * runs of '_' to a single '_' and trims leading / trailing '_'.
 */
export function sanitizeSlug(input) {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * @typedef {Object} ProvisionedNames
 * @property {string} databaseName  ≤63 chars, [a-z0-9_]+
 * @property {string} roleName      ≤63 chars, [a-z0-9_]+
 * @property {string} slug          the sanitized publisher slug used
 * @property {string} fingerprintHex first 12 chars of the fingerprint
 */

/**
 * Derive the database + role name pair from a fingerprint + publisher.
 *
 * @param {object} args
 * @param {string} args.fingerprint    sha256-hex from resolveFingerprint
 * @param {string} args.publisher      e.g. '@automagik/genie' (may be '')
 * @returns {ProvisionedNames}
 */
export function deriveProvisionedNames({ fingerprint, publisher }) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('deriveProvisionedNames: fingerprint must be a non-empty string');
  }
  // Hex encoding is the typical case (sha256-hex). For pinned-string
  // fingerprints (operator escape hatch) we still accept any chars, but
  // we strip them through the same sanitizer so the database identifier
  // stays valid.
  const hexLike = /^[0-9a-f]+$/.test(fingerprint);
  const fingerprintHex = hexLike
    ? fingerprint.slice(0, FINGERPRINT_HEX_LEN)
    : sanitizeSlug(fingerprint).slice(0, FINGERPRINT_HEX_LEN);
  if (fingerprintHex.length === 0) {
    throw new Error('deriveProvisionedNames: fingerprint produced an empty hex segment');
  }

  // Database identifier:
  //   PREFIX + slug + '_' + fingerprintHex   ≤ 63
  // → slug budget = 63 - len(PREFIX) - 1 - len(fingerprintHex)
  const dbSlugBudget = POSTGRES_MAX_IDENTIFIER - PREFIX.length - 1 - fingerprintHex.length;

  // Role identifier (separate budget — has to also fit ROLE_SUFFIX):
  //   PREFIX + slug + '_' + fingerprintHex + ROLE_SUFFIX   ≤ 63
  // → slug budget = 63 - len(PREFIX) - 1 - len(fingerprintHex) - len(ROLE_SUFFIX)
  const roleSlugBudget = dbSlugBudget - ROLE_SUFFIX.length;

  // We use the smaller of the two budgets so the same slug appears in
  // both names — operators reading `\l` and `\du` in psql see matched
  // pairs without surprise truncation.
  const slugBudget = Math.max(0, Math.min(dbSlugBudget, roleSlugBudget));

  const fullSlug = sanitizeSlug(publisher);
  const slug = fullSlug.slice(0, slugBudget);

  const databaseName = slug.length > 0
    ? `${PREFIX}${slug}_${fingerprintHex}`
    : `${PREFIX}${fingerprintHex}`;

  const roleName = slug.length > 0
    ? `${PREFIX}${slug}_${fingerprintHex}${ROLE_SUFFIX}`
    : `${PREFIX}${fingerprintHex}${ROLE_SUFFIX}`;

  return {
    databaseName,
    roleName,
    slug,
    fingerprintHex,
  };
}

export const __testInternals = Object.freeze({
  POSTGRES_MAX_IDENTIFIER,
  PREFIX,
  FINGERPRINT_HEX_LEN,
  ROLE_SUFFIX,
});
