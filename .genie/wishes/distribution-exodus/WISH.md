# Wish: distribution-exodus — pgserve → autopg, npm departure, v3.0.0

| Field | Value |
|-------|-------|
| **Status** | IN-PROGRESS — V3-3 doc cleanup ✅ · V3-1 verb rename ✅ · V3-2 npm-publish drop ✅ · V3 rename ⏳ (this cohort) · V3-4 release tag yours |
| **Slug** | `distribution-exodus` |
| **Date** | 2026-05-11 (formal wish-text scaffolded today — the plan was authored across multiple sessions; primary source is `agents/felipe/brain/work/pgserve/autopg-distribution-cutover-handoff.md` from 2026-05-03) |
| **Author** | Felipe Rosa (decisions) · genie-pgserve (this wish-text scaffold) |
| **Appetite** | medium — most of the plan already shipped piecemeal through v2.4-v2.6; v3 cohort is the final cutover |
| **Branch** | `wish/distribution-exodus` (this wish written from `feat/v3-rename-to-autopg`) |
| **Design** | [`agents/felipe/brain/work/pgserve/autopg-distribution-cutover-handoff.md`](../../  ../../agents/felipe/brain/work/pgserve/autopg-distribution-cutover-handoff.md) (locked decisions 2026-05-03 — see §2 "Locked decisions") |
| **Cross-references** | `.genie/wishes/pgserve-singleton-no-proxy/SHARED-DESIGN.md` Decision #1 reserves 3.0 for this cutover · `.genie/wishes/autopg-distribution-cutover-finalize/WISH.md` shipped the v2.6 prep work |

## Summary

Move pgserve off npm-as-canonical-distribution and rename the product to **autopg**. v3.0.0 is the first publishing without npmjs.com; installs flow via `install.sh` + GitHub Releases (cosign-keyless-signed tarballs); in-place updates flow via `autopg update`. The old `pgserve` CLI bin is dropped; the npm package `pgserve` stops receiving new versions (historical v2.x tarballs stay published — npm registry is immutable).

The repo will eventually move from `automagik-dev/autopg` to `automagik-dev/autopg` (the last cutover step — separate operator action).

## Scope

### IN (v3.0.0 cohort)

| Layer | Shipped via |
|---|---|
| Singleton verbs (doctor / trust / gc / provision / create-app / verify) | `autopg-distribution-cutover-finalize` cohort (PRs #86–#118) |
| Cosign keyless signing pipeline (build → sign → publish) | Wave A — PRs #114 (trust-loop core), #115 (release-publish wiring), #116 (docs), #117 (E2E CI gate), #118 (script keyless conversion) |
| Migration guide + schema/trust references | PR #110 (G4 docs cohort) — refreshed in PR #120 (V3-3 doc-hallucination fix) |
| `pgserve upgrade` → `autopg update` rename (clean cutover) | PR #121 (V3-1 verb rename) |
| Drop `npm publish` step from release pipeline | PR #122 (V3-2 npm-departure) |
| Drop `pgserve` CLI bin; package.json name `pgserve` → `autopg`; doc rebranding | **THIS PR (V3 rename)** |
| Cut tag `v3.0.0` | Felipe's operational step after this PR merges |

### OUT — deferred or already non-applicable

| Item | Reason |
|---|---|
| Repo rename `automagik-dev/autopg` → `automagik-dev/autopg` | Felipe Q2 (2026-05-11): *"this will be the last part. we will change org too"*. Trust regex + `install.sh REPO=` + every `github.com/automagik-dev/autopg` URL in the repo stays as-is until the actual `gh repo transfer` happens. Then a follow-up PR rewrites all references in lockstep. |
| `pgserve_meta` postgres table rename | Felipe Q3 (2026-05-11): *"leave this as is lets make the transition rename step by step, frontline is more important now"*. Different table from `autopg_meta` (already shipped); shares zero rows. Rename = DDL migration + breaking deployed v2.6.x hosts. Deferred. |
| npm "soft cut" tombstone advisory release | Original handoff §2 Topic 1 locked **B (soft cut)**: a final `pgserve@<last>` npm publish whose body is `console.error("npm publishing discontinued — install via curl https://get.automagik.dev/autopg \| bash"); process.exit(2);`. NOT in v3.0.0 cohort; could ship as a final `pgserve@2.6.x+1` advisory tarball post-v3.0.0 launch. Felipe directive currently silent on whether to publish this tombstone or just let npm-latest stay at v2.6.1. |
| CalVer `2.YYMMDD.N` versioning | Original handoff §2 Topic 2 locked CalVer keeping `2.` major. Superseded later by `pgserve-singleton-no-proxy` Decision #1 (semver v3.0.0). Going with v3.0.0. |
| `autopg.json` per-consumer manifest signing (LOCK 1) | Original handoff §2 Topic 5 — ALREADY SHIPPED via PR #104 (G3 create-app + manifest LOCK 1 cosign verifier). |
| All-in-one tarball (cli + postgres bins together) | Original handoff §2 Topic 6 — ALREADY SHIPPED via build-tarballs.yml + sign-attest.yml (autopg-`<v>`-`<plat>`.tar.gz ≈60MB single signed tarball per platform). |

## Decisions (v3 cohort)

| # | Decision | Source | Rationale |
|---|----------|--------|-----------|
| 1 | v3.0.0 = post-npm-departure cutover | `pgserve-singleton-no-proxy/SHARED-DESIGN.md` Decision #1 | Reserves a clean semver major for the cutover. Supersedes the original handoff §2 Topic 2 CalVer plan. |
| 2 | Drop `pgserve` CLI bin; only `autopg` remains | Felipe directive 2026-05-11, Q1: *"drop pgsrve"* (sic) | Major bump enables breaking-rename without alias gymnastics. |
| 3 | Repo rename happens LAST | Felipe directive 2026-05-11, Q2: *"this will be the last part. we will change org too"* | Decouples the rename PR from the GitHub admin step. Trust regex + URLs left intact in v3.0.0 release; a follow-up cleanup PR rewrites them once `gh repo transfer automagik-dev/autopg automagik-dev` runs. |
| 4 | `pgserve_meta` postgres table preserved | Felipe directive 2026-05-11, Q3: *"leave this as is lets make the transition rename step by step"* | Deployed v2.6.x hosts have `pgserve_meta` rows; renaming forces operator migration. Step-by-step approach prioritises frontline CLI/branding. |
| 5 | `package.json` `name` → `autopg` | Felipe directive 2026-05-11, Q4: *"yes"* | Local tooling (`bun install`, `npm pack`) reads this. Clean v3 branding; zero operational impact post-V3-2 (no more `npm publish`). |
| 6 | Wishes preserved as historical record | Implicit | Historical wishes (autopg-upgrade-command, autopg-console-dist, etc.) keep `pgserve <verb>` references in their TEXT — that was the verb at the time. Active wishes (autopg-distribution-cutover-finalize) get rewritten. |
| 7 | Soft-cut npm tombstone DEFERRED | Original handoff Topic 1 locked B but Felipe hasn't reconfirmed | Could ship after v3.0.0 launch as a final `pgserve@2.6.2` advisory tarball. Tracked here for visibility; not in this PR. |

## Success Criteria

- [x] `pgserve <verb>` no longer works at the shell after v3.0.0 install — only `autopg <verb>`
- [x] `package.json` `name` is `autopg`
- [x] `npm publish` step removed from release workflow (V3-2 PR #122)
- [x] `autopg update` is the canonical in-place migration verb (V3-1 PR #121)
- [x] Operator-facing docs reference `autopg <verb>` exclusively (this PR)
- [ ] `v3.0.0` tag cut on `main` → release-publish.yml emits a cosign-signed GitHub Release with `autopg-3.0.0-<platform>.tar.gz` assets (Felipe operational step)
- [ ] `install.sh` post-tag fetches `v3.0.0` cleanly on a fresh host (smoke-test post-release)
- [ ] (LATER) repo rename: `automagik-dev/autopg` → `automagik-dev/autopg` + follow-up PR rewrites trust regex + install.sh REPO + GitHub URLs
- [ ] (LATER) `pgserve_meta` table rename when operator-migration plan lands

## Execution Strategy

Single PR per logical layer; landed in sequence to keep diffs reviewable:

| PR | Scope | Status |
|---|---|---|
| #120 | V3-3 doc-hallucination cleanup (npm-install lines + fictional trust subsystems) | ✅ merged |
| #121 | V3-1 verb rename `pgserve upgrade` → `pgserve update` | ✅ merged |
| #122 | V3-2 drop `npm publish` step from version.yml | ✅ merged |
| (this PR) | V3 rename — drop `pgserve` bin, package.json `name`, operator-facing doc rebranding | ⏳ open |
| (yours) | Tag `v3.0.0` + run release workflow | gated on this PR merge |
| (follow-up) | Repo rename PR — only after `gh repo transfer automagik-dev/autopg automagik-dev` | future |
| (optional) | npm tombstone advisory release | future |

## Risks & Open Questions

- **Operators with `pgserve` muscle-memory** — they hit "unknown verb" on first `pgserve doctor` post-v3.0.0. Mitigation: install.sh + CHANGELOG explicitly say "the CLI is now `autopg`"; muscle-memory adapts.
- **Stale npm tarballs** — `npm install pgserve` continues to fetch v2.6.1 (the last npm-published version). Operators who don't read the migration note keep using a stale install. Mitigation: optional tombstone advisory release (Topic 1, deferred).
- **GitHub redirect window** — after the eventual repo rename, GitHub auto-redirects but cosign cert subjects change from `automagik-dev/autopg` → `automagik-dev/autopg`. The trust regex MUST update in lockstep with the repo rename PR; cannot lag.
- **`pgserve_meta` table preserved** is a long-term tech-debt entry — at some point the table name will need to align with the autopg branding. Tracked as a future operator-migration wish.

## Where this came from

The primary plan document is `agents/felipe/brain/work/pgserve/autopg-distribution-cutover-handoff.md` (2026-05-03), which captures Felipe's locked decisions across 9 brainstorm topics and 2 sequencing questions. That doc was never converted into a `.genie/wishes/distribution-exodus/WISH.md` at the time; this is the first formal wish-text scaffold. The handoff doc remains the source of truth for the original brainstorm; this wish captures the EVOLVED plan (post `pgserve-singleton-no-proxy` Decision #1's semver-3-major + post-Wave-A signing pipeline + Felipe's 2026-05-11 rename directive).
