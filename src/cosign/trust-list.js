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
    // genie's release.yml is an orchestrator that workflow_call's into
    // sign-attest.yml — the Fulcio SAN URI therefore binds to
    // sign-attest.yml@<ref>, not release.yml@<ref>. Verified against
    // both v4.260511.1 (released from main) and v4.260511.2 (released
    // from wish/genie-distribution-cutover-g1) bundle certificates on
    // 2026-05-11: both cert subjects are
    // `automagik-dev/genie/.github/workflows/sign-attest.yml@refs/tags/v4.260511.x`.
    // Same shape as pgserve's own entry below.
    identityRegexp: '^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@refs/tags/v.*$',
    description: 'Namastex automagik genie sign-attest workflow (GitHub Actions OIDC)',
  }),
  Object.freeze({
    id: 'automagik-omni-release',
    publisher: '@automagik/omni',
    issuer: SIGSTORE_GITHUB_ACTIONS_ISSUER,
    // Omni signing pipeline mirrors genie's orchestrator+workflow_call
    // pattern (Felipe directive 2026-05-11, decision 2.α for
    // `v3-prerelease-trust-loop` G2): release.yml orchestrates, the
    // cosign keyless sign-blob runs inside a reusable sign-attest.yml,
    // and the Fulcio SAN URI binds to sign-attest.yml@<ref>. Anchoring
    // here pre-emptively so omni's first signed tag (post-G2 merge)
    // verifies without a follow-up trust-list flip. Re-validate against
    // the first signed omni bundle during G4 smoke.
    identityRegexp: '^https://github.com/automagik-dev/omni/.github/workflows/sign-attest.yml@refs/tags/v.*$',
    description: 'Namastex automagik omni sign-attest workflow (GitHub Actions OIDC)',
  }),
  Object.freeze({
    id: 'automagik-pgserve-release',
    publisher: 'pgserve',
    issuer: SIGSTORE_GITHUB_ACTIONS_ISSUER,
    // Wave A (v2.6.x): pgserve's signing happens in `sign-attest.yml`,
    // not `release.yml` (which is the unrelated npm-publish workflow
    // with zero cosign content). Renaming sign-attest.yml → release.yml
    // would clobber that workflow, so we anchor the trust regex on
    // sign-attest.yml instead. Mirror image of genie PR #1725 (binding
    // release.yml@refs/tags/v* — same Sigstore identity discipline,
    // different workflow filename).
    identityRegexp: '^https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v.*$',
    description: 'Namastex automagik pgserve sign-attest workflow (GitHub Actions OIDC)',
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
