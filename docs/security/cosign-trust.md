# pgserve cosign trust anchor reference

This is the operator-facing reference for how pgserve binaries are signed, how
to verify them locally, and how the trust roots are anchored in code. It
complements the cohort docs:

- [`docs/migrations/v2.6-from-v2.5.md`](../migrations/v2.6-from-v2.5.md) — upgrade guide
- [`docs/pgserve-meta.md`](../pgserve-meta.md) — `pgserve_meta` + `autopg_meta` schema reference
- [`docs/trust-store.md`](../trust-store.md) — `~/.pgserve/trust/identities.json` reference + `pgserve trust` CLI

## TL;DR

```bash
# Download a release tarball + signing siblings
gh release download v2.6.4 --repo namastexlabs/pgserve

# Verify via pgserve verify (recommended — handles trust list automatically)
pgserve verify autopg-2.6.4-linux-x64-glibc.tar.gz

# OR raw cosign keyless verification
cosign verify-blob \
    --certificate-identity-regexp '^https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --signature autopg-2.6.4-linux-x64-glibc.tar.gz.sig \
    --certificate autopg-2.6.4-linux-x64-glibc.tar.gz.cert \
    autopg-2.6.4-linux-x64-glibc.tar.gz
```

## Trust model

pgserve uses cosign **keyless OIDC** signing (Sigstore-conventional). The
signing identity is encoded into the Fulcio certificate subject as a URI:

```
https://github.com/<owner>/<repo>/.github/workflows/<workflow>.yml@<ref>
```

Verifying a signature means verifying that the cert subject matches an entry
in the trust list. There is **no long-lived private key** held by the project;
each release tag mints a short-lived Fulcio cert via the GitHub Actions OIDC
token.

## Trust roots

Trust is layered in three tiers:

| Tier | Source | Mutability |
|------|--------|------------|
| 0 (binary build-time) | `src/cosign/trust-list.js` — `TRUSTED_IDENTITIES` | Frozen at build time; updated only by shipping a new pgserve binary |
| 1 (operator-extensible) | `~/.pgserve/trust/identities.json` | Mutated via `pgserve trust add` / `remove` |
| 2 (per-consumer locked) | `autopg_meta.locked_roots` per `pgserve create-app <slug>` | Snapshot of Tiers 0+1 frozen at create-app time; only that consumer reads it |

A binary verifies if **any** layer's regex matches its cert subject.

## Built-in `TRUSTED_IDENTITIES`

As of pgserve 2.6.x, three identities ship hardcoded (source:
`src/cosign/trust-list.js`):

| `id` | `publisher` | Cert subject regex |
|------|-------------|---------------------|
| `automagik-genie-release` | `@automagik/genie` | `^https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v.*$` |
| `automagik-omni-release` | `@automagik/omni` | `^https://github.com/automagik-dev/omni/.github/workflows/release.yml@refs/tags/v.*$` |
| `automagik-pgserve-release` | `pgserve` | `^https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v.*$` |

All three pin the Sigstore GitHub Actions OIDC issuer
(`https://token.actions.githubusercontent.com`) and require a tag-triggered
workflow_run.

**Why pgserve anchors on `sign-attest.yml`, not `release.yml`**: pgserve has
TWO release-related workflows. `release.yml` is the npm-publish pipeline
(modeled on khal-os/desktop) with zero cosign content. `sign-attest.yml` is
the cosign signing pipeline (Group 8 of the autopg-distribution-cutover
cohort). Renaming `sign-attest.yml` → `release.yml` would clobber the npm
workflow, so the trust regex anchors on the actual signing workflow file
(Wave A PR-A1 fix, mirror of `automagik-dev/genie` PR #1725).

## What the release pipeline ships

For each released version `v<version>`, GitHub Releases attaches one set per
platform plus an aggregate `manifest.json`:

```
autopg-<version>-linux-x64-glibc.tar.gz             # the tarball itself
autopg-<version>-linux-x64-glibc.tar.gz.sha256      # outer SHA256 receipt
autopg-<version>-linux-x64-glibc.tar.gz.sig         # cosign keyless signature
autopg-<version>-linux-x64-glibc.tar.gz.cert        # Fulcio cert (sigstore short-lived)
autopg-<version>-linux-x64-glibc.tar.gz.intoto.jsonl # SLSA L3 build provenance
# ...repeated for darwin-arm64, darwin-x64, linux-arm64, linux-x64-musl...
manifest.json                                       # aggregate metadata
```

Per-platform pipeline (see `.github/workflows/`):

```
git push origin v<version>
   ├── triggers build-tarballs.yml  → assembles autopg-<v>-<plat>.tar.gz + .sha256
   │     uploads as artifact: autopg-<v>-<plat>
   │
   └── workflow_run triggers sign-attest.yml
         ├── cosign sign-blob (keyless) → .sig + .cert
         ├── attest-build-provenance (SLSA L3) → .intoto.jsonl
         ├── cosign verify-blob (self-check) — gate-fails the run if the cert
         │     doesn't match the workflow's own identity regex
         ├── per-platform Upload signed bundle artifact
         └── aggregate job → autopg-signed-bundle-<v> (all platforms + manifest.json)
               │
               └── workflow_run triggers release-publish.yml
                     ├── downloads autopg-signed-bundle-<v> (cross-run fetch)
                     ├── sanity-checks every tarball has sig+cert+intoto+sha256 siblings
                     ├── gh release create v<version> + uploads all assets
                     └── updates .well-known/latest.json (stable channel only)
```

The chain is strictly serial via `workflow_run` — release-publish never runs
unless sign-attest succeeded. Closes the race window that previously shipped
releases with no signing artifacts (v2.6.0 + v2.6.1 baseline per engineer
T25 audit).

## Verification recipes

### Verify a downloaded release tarball

```bash
gh release download v2.6.4 --repo namastexlabs/pgserve
pgserve verify autopg-2.6.4-linux-x64-glibc.tar.gz
```

`pgserve verify` reads `TRUSTED_IDENTITIES` automatically + falls through to
`~/.pgserve/trust/identities.json`. Exit codes:
- `0` — verified
- `2` — verification rejected (cert doesn't match any trusted identity)
- `3` — invocation error (no signing material found, malformed CLI args, etc.)

### Verify against a specific consumer's locked trust roots

```bash
# Earlier: pgserve create-app @my-org/my-app  (snapshots trust at that moment)
pgserve verify --slug my_org_my_app autopg-2.6.4-linux-x64-glibc.tar.gz
```

This consults `autopg_meta.locked_roots` for the named slug instead of the
live trust list. Useful when operators want to pin trust at create-app time
and resist trust-list rotation.

### Raw cosign verification (no pgserve CLI)

```bash
cosign verify-blob \
    --certificate-identity-regexp '^https://github.com/namastexlabs/pgserve/.github/workflows/sign-attest.yml@refs/tags/v.*$' \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --signature autopg-2.6.4-linux-x64-glibc.tar.gz.sig \
    --certificate autopg-2.6.4-linux-x64-glibc.tar.gz.cert \
    autopg-2.6.4-linux-x64-glibc.tar.gz
```

Expected: `Verified OK`.

### SLSA L3 provenance verification (GitHub Releases tarballs)

```bash
gh attestation verify autopg-2.6.4-linux-x64-glibc.tar.gz --owner namastexlabs
```

Checks the inline `.intoto.jsonl` provenance bundle against Sigstore Rekor.
Asserts: this exact tarball was produced by this exact build job run.

### npm-side provenance (registry tarballs)

The npm registry separately signs the `pgserve` tarball via npm's Trusted
Publisher OIDC integration. Operators verifying an `npm install` tarball:

```bash
# Inspect provenance attached to a registry version
npm view pgserve@2.6.4 dist.attestations

# Or download + verify via gh attestation
npm pack pgserve@2.6.4
gh attestation verify pgserve-2.6.4.tgz --owner namastexlabs
```

This is **separate from** the cosign signing pipeline that produces
GitHub Releases tarballs (`autopg-<v>-<plat>.tar.gz` siblings). npm
provenance covers the `npm install` path; cosign covers the
`gh release download` path. Both flow through Sigstore Rekor; together
they cover both distribution surfaces.

Releases through v2.6.x (pre-D10) shipped without npm provenance — the
publish workflow set `NPM_CONFIG_PROVENANCE: "false"` as a workaround
for a sigstore-server 422 issue on self-hosted runners that no longer
applies. v2.6.x+1 onward emit provenance.

## Adding a custom trust root (operator)

If your organization signs pgserve consumers (e.g. internal apps that should
trust pgserve as a base layer), add a trust entry locally:

```bash
pgserve trust add my-org-release \
    --issuer https://token.actions.githubusercontent.com \
    --identity-regexp '^https://github.com/my-org/my-app/.github/workflows/release.yml@refs/tags/v.*$' \
    --publisher '@my-org/my-app' \
    --description 'My organization release pipeline'
```

See [`docs/trust-store.md`](../trust-store.md) for the full CLI reference,
file format, and precedence rules.

## Versioning the trust list

Trust roots are baked into the pgserve binary. Adding/removing a hardcoded
entry requires:

1. Edit `src/cosign/trust-list.js` — add/modify the `Object.freeze({...})`
   entry inside `TRUSTED_IDENTITIES`
2. Update `tests/cosign/trust-list.test.js` regression coverage
3. Add a CHANGELOG entry under the next release
4. Ship a new pgserve binary

Operators DO NOT modify hardcoded trust at runtime. `pgserve trust remove`
refuses to remove hardcoded entries (`pgserve trust remove
automagik-pgserve-release` exits with code 1).

## Single-file `pgserve-*` binaries vs `autopg-*.tar.gz` tarballs

Two artifact shapes historically existed on the release page:

| Artifact | Shape | Purpose | Signed? |
|----------|-------|---------|---------|
| `pgserve-<plat>` / `pgserve-<plat>.exe` | Single-file Bun-compiled executable | development convenience, single-file download | No (dropped from release page in Wave A PR-A2) |
| `autopg-<v>-<plat>.tar.gz` | Tarball (binary + postgres bundle + scripts) | Production distribution | Yes (cosign keyless + SLSA L3) |

Per Wave A PR-A2 (Mismatch 7 Option 1), the single-file binaries are no
longer attached to the release page. Operators who need them can build
locally via `bun run build:binary`. Production distribution flows
exclusively through the signed tarball path.

## Legacy keyed cosign (pre-Wave A)

pgserve releases through **v2.6.1** used **keyed** cosign (with
`keys/cosign.pub` checked into the repo + `COSIGN_PRIVATE_KEY` /
`COSIGN_PASSWORD` GitHub Actions secrets). Wave A (v2.6.x+) switches to
**keyless OIDC**. Operators verifying releases:

- **v2.6.2+**: use the keyless flags above (`--certificate-identity-regexp`
  + `--certificate-oidc-issuer` + `--certificate <tarball>.cert`).
- **v2.6.0 + v2.6.1**: shipped no signing artifacts at all (the wiring gap
  between `sign-attest.yml` and `release-publish.yml` meant signatures
  never reached the release page). `pgserve verify` against those releases
  returns FAIL — there's nothing to verify against. v2.6.0 + v2.6.1 are
  effectively unsigned releases; operators relying on supply-chain
  verification should upgrade to v2.6.2 or later.
- **≤v2.5.x**: predates the cosign signing pipeline entirely.

The `keys/cosign.pub` file is no longer present on `main` (it never made
it past the abandoned `wip: autopg-distribution-cutover#8` commit). The
two utility scripts that previously had stale references
(`scripts/verify-published-artifacts.sh` +
`scripts/aggregate-manifest.sh`) have been rewritten to use keyless
verification flags (`--certificate-identity-regexp` +
`--certificate-oidc-issuer` + `--certificate <tarball>.cert`). Custom
trust regexes can be threaded via `AUTOPG_TRUST_REGEX` env var or
`--trust-regex` CLI flag respectively.

## Where to file issues

Signing-pipeline bugs / trust-anchor questions:
- https://github.com/namastexlabs/pgserve/issues

Sigstore / cosign upstream issues:
- https://github.com/sigstore/cosign/issues

GitHub Actions OIDC binding questions:
- https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect

## See also

- [`src/cosign/trust-list.js`](../../src/cosign/trust-list.js) — `TRUSTED_IDENTITIES` source
- [`src/cosign/trust-store.js`](../../src/cosign/trust-store.js) — user-extensible store reader/writer
- [`src/commands/trust.js`](../../src/commands/trust.js) — `pgserve trust` CLI
- [`src/commands/verify.js`](../../src/commands/verify.js) — `pgserve verify` CLI
- [`.github/workflows/sign-attest.yml`](../../.github/workflows/sign-attest.yml) — keyless signing pipeline
- [`.github/workflows/release-publish.yml`](../../.github/workflows/release-publish.yml) — release-page assembly
