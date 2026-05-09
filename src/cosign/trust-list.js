/**
 * Hardcoded cosign trust list — Tier 2 (cosign_signed) identity table.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Identities listed here are baked into the binary (Decision P6 in the
 * wish). Operators cannot remove or override them; updates flow only
 * through `pgserve update` shipping a new build. User-extensible roots
 * live separately in `~/.pgserve/trust/identities.json` (Group 3 surface),
 * not here.
 *
 * Identity shape mirrors what `cosign verify` consumes via
 * `--certificate-identity` + `--certificate-oidc-issuer` flags. The
 * `identityRegexp` form (Sigstore conventional) accepts `--certificate-
 * identity-regexp`.
 *
 * SHARED-DESIGN.md §2.4 commits to GitHub Actions OIDC for the Namastex
 * automagik release workflows: `release.yml@refs/tags/v*`. We pin both the
 * exact issuer URL and the regexp form so callers can pick whichever
 * cosign CLI flag set is convenient.
 */

export const SIGSTORE_GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Hardcoded trust roots — frozen to prevent runtime mutation.
 *
 * Each entry:
 *   id            short stable identifier used in diagnostics
 *   publisher     `package.json` `pgserve.publisher` value the entry attests
 *   issuer        OIDC issuer URL (Sigstore --certificate-oidc-issuer)
 *   identityRegexp Sigstore --certificate-identity-regexp value
 *   description   human-readable summary for `pgserve trust list`
 */
export const TRUSTED_IDENTITIES = Object.freeze([
  Object.freeze({
    id: 'automagik-genie-release',
    publisher: '@automagik/genie',
    issuer: SIGSTORE_GITHUB_ACTIONS_ISSUER,
    identityRegexp: '^https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v.*$',
    description: 'Namastex automagik genie release workflow (GitHub Actions OIDC)',
  }),
  Object.freeze({
    id: 'automagik-omni-release',
    publisher: '@automagik/omni',
    issuer: SIGSTORE_GITHUB_ACTIONS_ISSUER,
    identityRegexp: '^https://github.com/automagik-dev/omni/.github/workflows/release.yml@refs/tags/v.*$',
    description: 'Namastex automagik omni release workflow (GitHub Actions OIDC)',
  }),
  Object.freeze({
    id: 'automagik-pgserve-release',
    publisher: '@automagik/pgserve',
    issuer: SIGSTORE_GITHUB_ACTIONS_ISSUER,
    identityRegexp: '^https://github.com/namastexlabs/pgserve/.github/workflows/release.yml@refs/tags/v.*$',
    description: 'Namastex automagik pgserve release workflow (GitHub Actions OIDC)',
  }),
]);

const TRUSTED_BY_ID = new Map(TRUSTED_IDENTITIES.map((e) => [e.id, e]));
const TRUSTED_BY_PUBLISHER = new Map(TRUSTED_IDENTITIES.map((e) => [e.publisher, e]));

export function getTrustedById(id) {
  return TRUSTED_BY_ID.get(id) || null;
}

export function getTrustedByPublisher(publisher) {
  return TRUSTED_BY_PUBLISHER.get(publisher) || null;
}

/**
 * Return the trust roots in serialized-list form for `pgserve trust list`.
 * Includes the hardcoded marker so the surface can refuse `trust remove`
 * operations against compiled-in entries.
 */
export function listHardcodedTrust() {
  return TRUSTED_IDENTITIES.map((entry) => ({
    ...entry,
    source: 'hardcoded',
    removable: false,
  }));
}
