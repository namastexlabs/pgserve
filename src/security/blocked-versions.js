/**
 * Hardcoded blocklist — pgserve-singleton-no-proxy wish, Group 5.
 *
 * Compile-time list of pgserve versions that `pgserve install` and
 * `pgserve update` MUST refuse, with a clear diagnostic. The trust root
 * is opaque to operators: they cannot edit this file at runtime, only
 * receive an updated list via `pgserve update`.
 *
 * Per SHARED-DESIGN.md §2.5: this is the ONLY revocation surface for v2.4+.
 * No Rekor consultation, no revoked.json sync, no DNS-served blocklist.
 * The list grows when a known-bad version ships and gets pinned here, then
 * an updated pgserve release rolls out via the normal channel.
 *
 * Format: array of { version, reason, advisoryUrl? } records.
 *   - version: exact semver string. Range matchers are intentionally
 *     unsupported — every blocked version is named explicitly so an
 *     auditor reading this file knows exactly what is rejected.
 *   - reason: one-line operator-facing explanation (printed on refusal).
 *   - advisoryUrl: optional pointer to a CVE/security advisory for the
 *     blocked release.
 */

/**
 * @typedef {Object} BlockedVersion
 * @property {string} version  Exact semver string (no ranges).
 * @property {string} reason   Operator-facing diagnostic line.
 * @property {string} [advisoryUrl]  Pointer to CVE/security advisory.
 */

/** @type {readonly BlockedVersion[]} */
export const BLOCKED_VERSIONS = Object.freeze([
  // Empty by default. Populate as known-bad versions are identified.
  // Example shape (uncomment + edit when a real block is needed):
  //   { version: '2.6.0', reason: 'Postmaster crash on Linux ARM64 — see #999', advisoryUrl: 'https://github.com/automagik-dev/autopg/security/advisories/GHSA-xxxx' },
]);

/**
 * Test-only override. The compile-time list is frozen so production code
 * cannot mutate it; tests need a way to inject blocked entries to exercise
 * the throw path. Populated via __addBlockedForTest() and consulted by
 * findBlocked() when non-empty. Cleared via __clearBlockedTestOverridesForTest().
 *
 * @type {BlockedVersion[]}
 */
const _testOverrides = [];

/**
 * Test-only — register an additional blocked entry for the lifetime of a
 * test. Call __clearBlockedTestOverridesForTest() in afterEach to keep
 * tests isolated.
 *
 * @param {BlockedVersion} entry
 */
export function __addBlockedForTest(entry) {
  if (!entry || typeof entry.version !== 'string' || typeof entry.reason !== 'string') {
    throw new Error('__addBlockedForTest: entry needs { version, reason }');
  }
  _testOverrides.push(entry);
}

/** Test-only — drop all entries registered via __addBlockedForTest. */
export function __clearBlockedTestOverridesForTest() {
  _testOverrides.length = 0;
}

/**
 * Find the blocklist entry for an exact version string, if any.
 * Considers both the compile-time BLOCKED_VERSIONS list and any test
 * overrides registered via __addBlockedForTest().
 *
 * @param {string} version
 * @returns {BlockedVersion | undefined}
 */
export function findBlocked(version) {
  if (typeof version !== 'string' || version.length === 0) return undefined;
  const fromOverrides = _testOverrides.find((b) => b.version === version);
  if (fromOverrides) return fromOverrides;
  return BLOCKED_VERSIONS.find((b) => b.version === version);
}

/**
 * Assert that a version is not blocked. Throws an Error with a stable,
 * grep-able prefix (`EBLOCKEDVERSION`) when the version is blocked, so
 * callers (cli-install / upgrade) can detect it and exit with a known code.
 *
 * @param {string} version
 * @throws {Error} when version is blocked
 */
export function assertNotBlocked(version) {
  const hit = findBlocked(version);
  if (!hit) return;
  const lines = [
    `EBLOCKEDVERSION: pgserve@${version} is blocked.`,
    `  reason: ${hit.reason}`,
  ];
  if (hit.advisoryUrl) lines.push(`  advisory: ${hit.advisoryUrl}`);
  lines.push('  remediation: install a different version (run `pgserve update` for the latest).');
  const err = new Error(lines.join('\n'));
  err.code = 'EBLOCKEDVERSION';
  err.version = version;
  err.reason = hit.reason;
  throw err;
}
