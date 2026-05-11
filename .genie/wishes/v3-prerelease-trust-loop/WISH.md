# Wish: v3-prerelease-trust-loop — gate v3.0.0 GA on end-to-end consumer parity

| Field | Value |
|-------|-------|
| **Status** | DRAFT — gating wish between `distribution-exodus` (v3 cohort, merged) and Felipe's `v3.0.0` tag-cut |
| **Slug** | `v3-prerelease-trust-loop` |
| **Date** | 2026-05-11 |
| **Author** | genie-pgserve |
| **Appetite** | medium — most of the lift is omni signing (~1–2 days); genie compliance is a verification pass; prerelease + E2E are mechanical |
| **Branch** | `wish/v3-prerelease-trust-loop` |
| **Design** | Direct wish — extends the `distribution-exodus` cohort with a pre-GA gate |
| **Cross-references** | `.genie/wishes/distribution-exodus/WISH.md` (v3 cohort source-of-truth) · `src/cosign/trust-list.js` (Tier-2 trust roots) · `tests/integration/wave-a-e2e.test.sh` (existing keyless E2E template) |

## Summary

Before cutting `v3.0.0` GA + transferring `namastexlabs/pgserve` → `automagik-dev/autopg`, both consumer trust-loop entries (`automagik-genie-release`, `automagik-omni-release`) must verify end-to-end against a real pgserve binary. Today only genie satisfies the signed-app contract; omni is a Tier-2 trust-list entry without a single cosign-signed release artifact. This wish gates GA on a **prerelease (`v3.0.0-rc.0`) → consumer parity → GA** sequence so the trust loop is proven in production before the org transfer happens.

## Audit findings (2026-05-11)

| App | Repo | Trust-list match | Signing pipeline | Signed assets in latest release | Verdict |
|-----|------|------------------|------------------|---------------------------------|---------|
| **genie** | `automagik-dev/genie` | `automagik-genie-release` → `release.yml@refs/tags/v.*` | ✅ keyless cosign sign-blob + self-verify + tamper-detection + signing-identity-pin.yml four-channel | ✅ `v4.260511.2`: `genie-<v>-<plat>.tar.gz` + `.bundle` + `.intoto.jsonl` × 4 platforms (12 assets) | ✅ COMPLIANT (deep verification still pending — see G1) |
| **omni**  | `automagik-dev/omni`  | `automagik-omni-release` → `release.yml@refs/tags/v.*` | ❌ **release.yml is npm-publish-only — zero cosign content** | ❌ `v2.260510.1`: **0 attached assets** (npm tarball only) | ❌ **NOT COMPLIANT** — blocker for v3 GA |

## Scope

### IN

- **G1 — Deep genie compliance verification** (1–2h): pull genie `v4.260511.2` tarball + bundle, run `pgserve verify --slug genie` against a v3-rc binary, confirm bundle format + cert identity regex matches trust-list, confirm `pgserve verify` exit code reflects the trust decision. Surface any gaps as fix-ups inline.
- **G2 — Omni release.yml cosign signing pipeline** (1–2 days, the long pole): mirror genie's pattern in `automagik-dev/omni/.github/workflows/release.yml` — install cosign → build platform tarballs → `sign-blob --output-signature --output-certificate --bundle` → upload to GH release → self-verify with `--certificate-identity-regexp` → tamper-detection self-test. Plus `signing-identity-pin.yml` four-channel pin guard. Plus `SECURITY.md` pin update.
- **G3 — Cut `pgserve v3.0.0-rc.0` prerelease** (30min): tag pgserve main, fire `sign-attest.yml` → `release-publish.yml` with `channel=beta`, confirm `--prerelease` flag flips on the resulting GH Release. Smoke `install.sh` end-to-end against the rc tag.
- **G4 — End-to-end consumer verification against v3-rc** (2–3h): on a fresh host, install `pgserve v3.0.0-rc.0` via install.sh; run `pgserve verify --slug genie` against latest genie tag → PASS; cut a fresh `omni v2.x` tag post-G2 → run `pgserve verify --slug omni` against it → PASS. Both must succeed before GA.
- **G5 — Cut `v3.0.0` GA + repo transfer** (Felipe operational step): tag `v3.0.0` on pgserve main (`channel=stable`, GA), execute `gh repo transfer namastexlabs/pgserve automagik-dev/autopg`, ship the cleanup PR that rewrites trust regex anchors + install.sh REPO + workflow file references to the new org/repo coordinates.

### OUT

| Item | Reason |
|------|--------|
| `pgserve_meta` postgres table rename | Already deferred in `distribution-exodus` per Felipe Q3. Same posture here. |
| npm tombstone advisory release | Already deferred in `distribution-exodus` Topic 1. Optional post-GA. |
| Trust-list expansion to other consumers (brain, rlmx, hapvida-eugenia, email) | None of those are Tier-2 signed apps today; they don't need cosign verification for v3. Tracked separately if/when they consume signed pgserve directly. |
| Auto-detect `-rc.N` / `-beta.N` semver suffix → channel mapping in `release-publish.yml` | Workflow currently defaults tag-push to `channel=stable` — relying on `workflow_dispatch` with `channel=beta` for G3. Auto-detection is nice-to-have; not required for this wish. Tracked as follow-up. |
| genie's release.yml uplift (already shipped) | No work needed. Pulled into G1 as verification only. |

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Gate v3 GA on a prerelease cycle, not direct cut** | Repo transfer changes cosign cert subject identity (`namastexlabs/pgserve` → `automagik-dev/autopg`). Once transferred, the trust regex must update in lockstep and a stale binary cannot verify newer releases. Prereleasing v3-rc against the current org first lets us catch every "I forgot to update X" before the regex window changes. |
| 2 | **Omni signing pipeline mirrors genie's exactly** | genie has 6 months of operator burn-in on this pattern (sign-blob + self-verify + tamper-detect + four-channel pin). Copy the working shape — don't invent a second pattern. |
| 3 | **Omni keeps `omni-v2` at the monorepo root** | Trust-list regex matches on the cosign cert *subject* (workflow path + repo), not on the package name. Real publish target `packages/cli/@automagik/omni` already aligns with trust-list `publisher: '@automagik/omni'`. Renaming the root would cascade through turbo + workspaces with zero security benefit. |
| 4 | **Manual `workflow_dispatch` for G3 prerelease** | `release-publish.yml`'s channel-resolution step defaults tag-push to `channel=stable` with no semver-suffix auto-detection. Cleanest path for one-off rc is manual dispatch with `channel=beta`. Auto-detection is a separate cleanup (listed under OUT). |
| 5 | **G4 must run on a fresh host, not a dev workstation** | Trust-loop bugs hide behind any `~/.pgserve/` or `~/.autopg/` state from prior installs. A fresh host (or a `HOME=$(mktemp -d)` isolated install) is the only way to prove the install.sh + verify path works for a real new operator. |
| 6 | **Omni signing PR lands in omni repo, not pgserve** | Cross-repo work — pgserve owns the trust list, omni owns its own release workflow. PR description on the omni side will reference this wish + the trust-list entry it satisfies. |

## Success Criteria

- [ ] **G1**: `pgserve verify --slug genie` (run against v3-rc binary on a fresh host) prints PASS + cert identity = `automagik-dev/genie/.github/workflows/release.yml@refs/tags/v4.260511.2` against the genie `v4.260511.2` bundle
- [ ] **G2-a**: omni `release.yml` has cosign keyless sign-blob step emitting `.sig` + `.cert` + `.bundle` per platform tarball
- [ ] **G2-b**: omni `release.yml` self-verify step uses `--certificate-identity-regexp '^https://github.com/${{ github.repository }}/.github/workflows/release.yml@'`
- [ ] **G2-c**: omni `release.yml` tamper-detection self-test rejects a mutated tarball (mirror genie line 295–326)
- [ ] **G2-d**: omni adds `.github/workflows/signing-identity-pin.yml` four-channel pin guard
- [ ] **G2-e**: omni adds `SECURITY.md` pinned identity block + `.github/cosign.pub` (NO-KEY placeholder) + `.well-known/security.txt` + `.github/ISSUE_TEMPLATE/signing-key-fingerprint.md` (four channels matching genie's surface)
- [ ] **G2-f**: a fresh omni tag (`v2.<calver>.<n>+1` post-G2 merge) emits `omni-<v>-<plat>.tar.gz` + `.bundle` + `.intoto.jsonl` × N platforms as GH Release assets
- [ ] **G3-a**: pgserve `v3.0.0-rc.0` tag created on `main`; `sign-attest.yml` succeeds
- [ ] **G3-b**: `release-publish.yml` manual dispatch (or auto-trigger) emits GH Release with `--prerelease` flag set, all `autopg-3.0.0-rc.0-<plat>.tar.gz` + sibling assets attached
- [ ] **G3-c**: `install.sh` on a fresh host, pointed at the rc, installs cleanly and `autopg --version` reports `3.0.0-rc.0`
- [ ] **G4-a**: on the fresh host with v3.0.0-rc.0 installed: `pgserve verify --slug genie` against `genie@v4.260511.2` → PASS
- [ ] **G4-b**: on the fresh host with v3.0.0-rc.0 installed: `pgserve verify --slug omni` against the fresh post-G2 omni tag → PASS
- [ ] **G5-a**: pgserve `v3.0.0` GA tag cut on `main`, `release-publish.yml` runs with `channel=stable`, GH Release published WITHOUT `--prerelease`
- [ ] **G5-b**: `gh repo transfer namastexlabs/pgserve automagik-dev/autopg` executed (Felipe operational step)
- [ ] **G5-c**: post-transfer cleanup PR merges — trust regex anchors flip to `automagik-dev/autopg` (with backwards-compat dual-regex window if needed; TBD during G5)

## Execution Strategy

Sequential gates — each unblocks the next. G1 and G2 can run in parallel (different repos).

| Group | Order | Owner | Cross-repo? | Notes |
|-------|-------|-------|-------------|-------|
| G1 | parallel with G2 | genie-pgserve | read-only on genie | Verification pass + any inline fix-ups |
| G2 | parallel with G1 | engineer (omni) | yes — `automagik-dev/omni` | Single PR mirroring genie pattern; ~6–8 files |
| G3 | after G2 merged | genie-pgserve + Felipe | no | Tag cut + workflow dispatch |
| G4 | after G3 published | genie-pgserve | spans both consumer repos | Fresh-host smoke; isolated `HOME` |
| G5 | after G4 PASS | Felipe | yes — `automagik-dev/*` | Tag GA + repo transfer + cleanup PR |

## Risks & Open Questions

- **Omni is a monorepo with no platform tarballs today** — release.yml only publishes the npm package. To sign tarballs, omni first needs a `build-tarballs.yml` (or equivalent inline step) that produces platform binaries. This is the bulk of G2's work; not just "add cosign", but "add the artifact cosign signs". Cost estimate: 1–2 days.
- **Trust regex must survive the org transfer** — once `gh repo transfer` runs, the cosign cert subject changes from `namastexlabs/pgserve` to `automagik-dev/autopg`. Trust regex in v3.0.0 GA binary still points at `namastexlabs/pgserve` for self-verification. Mitigation: either (a) transfer BEFORE GA tag-cut so v3.0.0's own signing is already under the new org (cleaner but requires DNS/CI/secrets pre-flight), or (b) ship v3.0.0 under old org, then in G5 cleanup PR add a dual-regex transitional window. Decide during G3 review.
- **Omni's build target shape** — does omni ship a single binary (like genie's `bun build --compile`) or a node tarball? Affects what gets cosigned. Need a 30-min spike during G2 kickoff to pick the artifact shape. Cosign signs whatever is uploaded; we just need to commit to the shape consistently with `pgserve verify --slug omni`'s expectations.
- **Operator surface for `pgserve verify --slug omni` today** — pgserve `verify --slug` resolves the consumer manifest via `~/.autopg/<slug>/admin.json`. Omni doesn't write one today. G4 needs to clarify whether `pgserve create-app omni` is part of the smoke (it should be — that's the manifest LOCK 1 path).
- **Bundle vs detached** — pgserve consumes both formats post WAVE-B-BUNDLE-FORMAT fix (task #88). Either works; omni picks one and stays consistent.

## What this unlocks

- v3.0.0 GA can ship knowing **every Tier-2 trust root has been verified end-to-end against the actual release binary** — no "we'll catch it in production" gaps.
- Org transfer (`namastexlabs/pgserve` → `automagik-dev/autopg`) happens on a known-good baseline, with both consumers already validated.
- Omni gets the same signing posture as genie — operationally consistent, single mental model for the trust loop.
- The signed-app contract becomes load-bearing: future consumers (brain, rlmx) have a clear template to follow.

## Where this came from

Felipe direction 2026-05-11: *"before transferring and before actually cutting v3, i need to make sure both genie and omni are signed apps. that's not the case today. i need you to help me review that."* Surface audit surfaced the omni gap immediately; this wish captures the work needed to close it before GA.
