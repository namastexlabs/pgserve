/**
 * Locked-roots loader — reads `autopg_meta.locked_roots` for a slug.
 *
 * pgserve singleton (v2.6) — `autopg-distribution-cutover-finalize`
 * wish, Group 3 (deliverable D4a). Companion to `pgserve verify --slug
 * <slug>` (D4b): the verify verb passes the loaded `lockedRoots` as
 * `options.trustList` to `verifyBinary()` so verification runs against
 * the frozen-at-create-app snapshot, not the live `TRUSTED_IDENTITIES`.
 *
 * Why this is its own module:
 *   - keeps create-app + verify decoupled (verify must not import
 *     create-app's full verb code);
 *   - lets tests stub the loader via dependency injection without
 *     spinning up postgres;
 *   - mirrors the cohort-canonical pattern of one psql-shellout file
 *     per concern (provision/queries.js, gc/queries.js, etc.).
 *
 * Structured errors with stable `code` values let `pgserve verify`'s
 * error-mapping layer pick the correct exit code:
 *
 *   EAUTOPGMETAMISSING  table doesn't exist (schema not bootstrapped on
 *                       this postmaster — operator hasn't run any
 *                       `pgserve create-app` yet) → invocation problem
 *   EAUTOPGSLUGUNKNOWN  table exists but no row for slug → invocation
 *                       problem; actionable message includes the
 *                       remediation `pgserve create-app <slug>`
 *   EAUTOPGLOCKEDPARSE  row exists but locked_roots JSONB is malformed
 *                       (file rot / direct-mutation accident) →
 *                       invocation problem
 */

import { pgQuery, quoteLiteral } from '../lib/pg-query.js';
import { sanitizeSlug } from '../provision/db-naming.js';

/**
 * Load the locked-roots snapshot for a slug.
 *
 * @param {object} args
 * @param {string} args.slug  raw or sanitized slug; sanitizeSlug runs
 *                            inside so callers can pass either form.
 * @param {number} [args.port=5432]
 * @returns {{
 *   slug: string,
 *   lockedRoots: Array<object>,
 *   createdAt: string,
 *   lastUpdated: string,
 *   manifestPath: string,
 * }}
 * @throws Error with `.code` set to one of EAUTOPGMETAMISSING /
 *         EAUTOPGSLUGUNKNOWN / EAUTOPGLOCKEDPARSE on the structured
 *         failure modes above; the underlying psql error otherwise.
 */
export function loadLockedRoots({ slug, port = 5432 } = {}) {
  if (typeof slug !== 'string' || slug.trim().length === 0) {
    throw new TypeError('loadLockedRoots: slug must be a non-empty string');
  }
  const sanitized = sanitizeSlug(slug);
  if (sanitized.length === 0) {
    const err = new Error(
      `loadLockedRoots: slug "${slug}" sanitizes to empty; pick a slug `
      + 'with at least one alphanumeric character',
    );
    err.code = 'EAUTOPGSLUGUNKNOWN';
    throw err;
  }

  // Probe the table existence in the same query so we can disambiguate
  // "table missing" from "row missing". `to_regclass` returns NULL when
  // the relation is absent in the active search_path; we wrap the
  // SELECT in a CTE that conditionally returns 'NO_TABLE' / 'NO_ROW' /
  // the tab-separated payload. Plain text comes back via psql -At -F\t.
  const sentinel = '__autopg_loaded__';
  const sql = [
    "WITH t AS (SELECT to_regclass('public.autopg_meta') AS rel)",
    'SELECT',
    "  CASE WHEN t.rel IS NULL THEN 'NO_TABLE' ELSE",
    `    COALESCE((SELECT '${sentinel}\t' || locked_roots::text || '\t' ||`,
    "             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || '\t' ||",
    "             to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') || '\t' ||",
    '             manifest_path',
    '             FROM public.autopg_meta',
    `             WHERE slug = ${quoteLiteral(sanitized)} LIMIT 1), 'NO_ROW')`,
    '  END AS payload',
    'FROM t',
  ].join('\n');

  const out = pgQuery({ sql, port, captureStdout: true });

  if (out === 'NO_TABLE') {
    const err = new Error(
      `loadLockedRoots: public.autopg_meta does not exist on this postmaster `
      + '(no apps registered yet — run `pgserve create-app <slug>` to bootstrap)',
    );
    err.code = 'EAUTOPGMETAMISSING';
    throw err;
  }

  if (out === 'NO_ROW' || !out.startsWith(`${sentinel}\t`)) {
    const err = new Error(
      `loadLockedRoots: no autopg_meta row for slug "${sanitized}" `
      + `— run \`pgserve create-app ${sanitized}\` first`,
    );
    err.code = 'EAUTOPGSLUGUNKNOWN';
    err.slug = sanitized;
    throw err;
  }

  // Strip the sentinel + parse the four tab-separated fields.
  const payload = out.slice(sentinel.length + 1);
  const [lockedRootsJson, createdAt, lastUpdated, manifestPath] = payload.split('\t');

  let lockedRoots;
  try {
    lockedRoots = JSON.parse(lockedRootsJson);
  } catch (err) {
    const wrap = new Error(
      `loadLockedRoots: locked_roots JSONB for slug "${sanitized}" is malformed: ${err.message}`,
    );
    wrap.code = 'EAUTOPGLOCKEDPARSE';
    wrap.slug = sanitized;
    wrap.cause = err;
    throw wrap;
  }
  if (!Array.isArray(lockedRoots)) {
    const err = new Error(
      `loadLockedRoots: locked_roots for slug "${sanitized}" is not a JSON array `
      + `(got ${typeof lockedRoots})`,
    );
    err.code = 'EAUTOPGLOCKEDPARSE';
    err.slug = sanitized;
    throw err;
  }

  return {
    slug: sanitized,
    lockedRoots,
    createdAt,
    lastUpdated,
    manifestPath,
  };
}
