# Wish: autopg distribution cutover — finalize (close v2.4 leftovers + tech debt)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `autopg-distribution-cutover-finalize` |
| **Date** | 2026-05-09 |
| **Author** | genie-pgserve |
| **Appetite** | 1 week (5 groups, mostly small; G3 is the only meaty one) |
| **Branch** | `wish/autopg-distribution-cutover-finalize` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Closes the leftover work from the never-materialized `autopg-distribution-cutover` plan plus the technical debt accrued during the singleton-G3 sprint (PRs #86–#92). Scope: install.sh path-collision decision, pgserve create-app + manifest LOCK 1 cosign verifier, consumer migrations + final v2.4 validation, and the pg-query / integration-test / audit-rotation cleanup.

## Scope

### IN

- **G1 — install.sh path-collision (Cutover G10)**: rename main's existing `install.sh` (123 lines, legacy) so the new ≤80-line `install-autopg.sh` can land without overwriting; pivot fetching URLs to `github.com/.../releases/download/...`.
- **G2 — pg-query dedup + integration test scaffold (singleton-G3 tech debt)**: collapse `src/gc/pg-queries.js` into `src/lib/pg-query.js` (the canonical one shipped in PR #92); add `tests/integration/gc-provision.test.sh` that spins up a real postmaster and exercises the `provision → gc --apply → provision` round-trip end-to-end.
- **G3 — pgserve create-app + manifest LOCK 1 (Cutover G5)**: ship `pgserve create-app <slug>` that writes a per-consumer manifest, registers it under `autopg_meta`, and locks the cosign trust roots used to verify follow-up upgrades. ~660 LOC; needs the `admin-bootstrap.js` + `autopg_meta` schema infrastructure that doesn't exist on main yet.
- **G4 — consumer migrations + docs (Cutover G12-G18)**: pgserve consumers (brain, omni, rlmx, hapvida-eugenia, email) get explicit migration recipes; CHANGELOG entries for v2.6 capture the singleton verbs (`doctor`, `trust`, `gc`, `provision`); the `pgserve_meta` schema + `~/.pgserve/trust/identities.json` user-extensible store get user-facing docs in `docs/`.
- **G5 — final v2.4 validation + release prep**: end-to-end smoke against a fresh host (npx install → provision → use → gc); audit log rotation policy (when do daily `gc-<DATE>.log` files get pruned?); changelog + release-notes for v2.6.

### OUT

- **Tier B service install** (`autopg service install --user systemd-user / launchd`) — already covered by the parked `autopg-service-install-system` wish.
- **Self-healing `pgserve update`** (Singleton G6) — already covered by `pgserve-singleton-no-proxy` Group 6.
- **Roles + GRANTs schema audit** (Singleton G7) — already covered by `pgserve-singleton-no-proxy` Group 7.
- **Migration tooling for existing pre-v2.4 hosts** (Singleton G8) — already covered by `pgserve-singleton-no-proxy` Group 8.
- **Cross-repo install reuse** (genie/omni install + brain ingestion) — already covered by `canonical-pgserve-pm2-supervision` Groups 2–4.
- **Provider-side cosign signing infrastructure** — already shipped via the GitHub Releases pivot in PR #84.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Rename old `install.sh` → `install-pgserve-legacy.sh`; new script lands at the canonical name `install-autopg.sh` (no `install.sh` on main post-merge) | Operators with bookmarked URLs to `install.sh` get a 404 + a clear hint; the new install script gets the canonical name `install-autopg.sh` matching the umbrella tooling concept, not the obsolete `install.sh` (which existed only because pgserve was renamed once before). |
| 2 | `src/lib/pg-query.js` is the canonical psql shellout primitive | Already shipped via PR #92 with `-F\t` + `ON_ERROR_STOP=1` + the PGPASSWORD-only-when-set fix from the bot reviews. `src/gc/pg-queries.js` is the older copy (PR #91) that still has all those fixes too but lives in the wrong directory; G2 dedupes it. |
| 3 | Integration tests use a real postgres, not pg-mem or mocks | `pgserve provision` and `pgserve gc` shell out to `psql`; mocking psql defeats the contract under test (parser delimiters, `ON_ERROR_STOP`, error-text matching). The bot reviews on #91/#92 caught real bugs that mocks would not have surfaced; integration tests must mirror real-world. |
| 4 | Audit log rotation = "delete files >90 days old on the next gc run" | No daemon, no cron — gc runs are operator-triggered. 90-day default matches the wish's 30-day staleness window with a 3x safety margin for forensic review of "why did my DB disappear?" cases. |
| 5 | G3 (pgserve create-app) is gated on the `autopg_meta` schema landing first | Per HANDOFF audit notes: G3 needs `admin-bootstrap.js` + `autopg_meta` schema infrastructure that doesn't exist on main. G3's first deliverable is that schema; the create-app verb is the second deliverable in the same group so they ship atomically. |
| 6 | `provision` advisory-lock helpers stay on main as foundation | `src/provision/advisory-lock.js` is correct and reusable for a future single-session caller (daemon mode, batch provisioner). Removing it now would force a re-implementation later. The CLI verb just doesn't call it (documented in `src/commands/provision.js` header). |
| 7 | **Binary name = `pgserve`; `autopg` is the umbrella concept name only** | The npm package + `bin/pgserve-wrapper.cjs` are unchanged. All new CLI verbs invoke as `pgserve <verb>` (matches what shipped in PRs #86–#92: `pgserve doctor` / `trust` / `gc` / `provision`). `autopg` appears in directory paths (`~/.autopg/`), pm2 process names (`autopg-server`, `autopg-ui`), wish slugs, and umbrella-concept references — but never as a CLI verb. **G3's create-app verb is `pgserve create-app`**, not `autopg create-app`. |
| 8 | **Cohort lands as v2.6.0** (title says "v2.4" for historical scope-naming only) | v2.5 already shipped on main between the singleton-G3 sprint design and this finalize wish. The cohort's _content_ is the original v2.4 plan; the _release tag_ this wish ships under is v2.6.0. Title kept as-is (refers to scope name) but G5 acceptance + release prep target v2.6.0. |

## Success Criteria

- [ ] `install.sh` renamed and 404-hint published; new `install-autopg.sh` ≤80 lines fetches from GitHub Releases and verifies via `gh attestation verify`.
- [ ] `src/gc/pg-queries.js` deleted; gc imports from `src/lib/pg-query.js`; no behavior change (gc tests still pass).
- [ ] `tests/integration/gc-provision.test.sh` runs against a real postmaster and proves the round-trip (provision creates DB + role; gc dry-run reports zero orphans; remove the source path; gc --apply drops the orphan + cleans the meta row; second provision recreates cleanly).
- [ ] `pgserve create-app <slug>` produces a per-consumer manifest registered in `autopg_meta`; cosign trust roots locked at create time; subsequent upgrades verified against the locked roots.
- [ ] CHANGELOG entry for v2.6 lists every singleton verb (doctor / trust / gc / provision) with one-line operator-facing description.
- [ ] `docs/pgserve-meta.md` documents the schema + every column purpose; `docs/trust-store.md` documents `~/.pgserve/trust/identities.json` schema + `pgserve trust` verbs.
- [ ] Audit log rotation: `pgserve gc` deletes `~/.pgserve/audit/gc-<DATE>.log` files older than 90 days at start of each run; rotation event is itself audited.
- [ ] Final v2.4 smoke: a fresh host running `npx pgserve install` followed by a sequence of `provision`, real workload, then `gc --apply` produces zero orphan databases and a clean audit trail.

## Execution Strategy

Five waves; G2 (dedup + integration test scaffold) is parallelizable with G1 (install.sh) since they touch unrelated files. G3 (create-app) is the longest pole and gates G4/G5.

| Wave | Group(s) | Why this ordering |
|------|----------|-------------------|
| 1 | G1 (install.sh) + G2 (pg-query dedup + integration tests) | Both small + independent; can ship in parallel. G2 unblocks regression coverage for everything that follows. |
| 2 | G3 (pgserve create-app + manifest LOCK 1) | Long pole. Needs `admin-bootstrap.js` + `autopg_meta` schema infra that doesn't exist; gates everything that ships consumer-facing artifacts. |
| 3 | G4 (consumer migrations + docs) | Depends on G3 for the create-app verb consumers will adopt; depends on G2 for the integration test pattern they'll mirror. |
| 4 | G5 (final v2.4 validation + release) | Last; requires every other group merged so the smoke test exercises the full stack. |

## Execution Groups

> Group titles include "(Cutover G##)" annotations referring to the planning numbering in the parent `autopg-distribution-cutover` cohort audit (`HANDOFF.md` checkpoints + commit `a212d38` audit doc) — informational only, this wish stands alone and does not require dereferencing those numbers.

### Group 1: install.sh path-collision + GitHub Releases URL pivot (Cutover G10)
**Goal:** Land an ≤80-line `install-autopg.sh` that fetches from GitHub Releases, verifies via `gh attestation verify`, without overwriting the legacy `install.sh`.

**Deliverables:**
1. Rename `install.sh` → `install-pgserve-legacy.sh` and add a top-of-file deprecation comment with the migration link.
2. Create `install-autopg.sh` (≤80 lines): detect platform → fetch the matching tarball from `github.com/namastexlabs/pgserve/releases/download/v<version>/...` → verify via `gh attestation verify` → extract → `pgserve install`.
3. Update `README.md` install instructions to point at the new script.
4. Optional: small redirect note at the top of `install-pgserve-legacy.sh` so operators running it get a clear "use install-autopg.sh instead" message.

**Acceptance Criteria:**
- [ ] `wc -l install-autopg.sh` returns ≤80.
- [ ] `bash install-autopg.sh --dry-run` (or equivalent) prints the fetch URL + verify command without executing them, on macOS-arm64 and linux-x64.
- [ ] Running `install-pgserve-legacy.sh` emits a deprecation note on stderr but still succeeds (doesn't break in-flight scripts).
- [ ] The cosign verification step uses `gh attestation verify` (Sigstore Rekor public-good) — no private CDN, no custom verifier.

**Validation:**
```bash
shellcheck install-autopg.sh install-pgserve-legacy.sh
wc -l install-autopg.sh
bash install-autopg.sh --help
```

**depends-on:** none

---

### Group 2: pg-query dedup + integration test scaffold (singleton-G3 tech debt)
**Goal:** Single canonical psql shellout primitive + a real-postgres integration test that exercises the `provision → gc` round-trip.

**Deliverables:**
1. Delete `src/gc/pg-queries.js`. Move every export gc relied on (`selectMetaRows`, `selectExistingDbs`, `selectActiveDbs`, `dropDatabase`, `deleteMetaRow`) into `src/lib/pg-query.js` or a new `src/gc/queries.js` that imports the primitive `pgQuery` / `quoteIdent` / `quoteLiteral` from `src/lib/pg-query.js`.
2. Update `src/commands/gc.js` imports.
3. Update `tests/gc/pg-queries.test.js` → `tests/gc/queries.test.js` to point at the new module path.
4. New `tests/integration/gc-provision.test.sh`: starts an ephemeral postgres on a high port, runs `pgserve provision <fp>` twice (idempotency check), then `pgserve gc --dry-run` (zero orphans expected), then removes the source path, then `pgserve gc --apply` (one orphan dropped expected), asserts the audit log contains the expected `start / skip / drop / finish` events.
5. Wire the integration test into CI as an optional matrix job (skipped on hosts without Docker / postgres).

**Acceptance Criteria:**
- [ ] `bun run lint` clean; `bun run deadcode` clean.
- [ ] `bun test` (unit) still passes — no regression on gc/provision pure-side tests.
- [ ] Integration test runs locally against a docker postgres image and exits 0.
- [ ] CI integration matrix job is wired and passes when run; runs as an optional / non-blocking matrix until GHA cache is warm (see Risks below — hard-gating is deferred).

**Validation:**
```bash
bun test tests/cli/gc.test.js tests/cli/provision.test.js tests/lib/pg-query.test.js
bash tests/integration/gc-provision.test.sh
```

**depends-on:** none (can ship in parallel with G1)

---

### Group 3: pgserve create-app + manifest LOCK 1 cosign verifier (Cutover G5)
**Goal:** Per-consumer manifest registration with locked-at-create-time cosign trust roots; cosign verifier checks every upgrade against those roots.

**Deliverables:**
1. `admin-bootstrap.js` — the missing piece per HANDOFF: writes the per-consumer state file at `~/.autopg/<scope>/admin.json`. Schema: `{ slug, manifestPath, lockedRoots: [...], createdAt }`. **Path is per-consumer + scoped under `<scope>/`** — orthogonal to the host-level `~/.autopg/admin.json` owned by `canonical-pgserve-pm2-supervision` G1 (which records supervisor mode for the whole host). The two files never collide.
2. `autopg_meta` schema (table + indexes), CREATE-TABLE module shaped like `src/schema/pgserve-meta.js`. Lives in a SEPARATE postgres table from `pgserve_meta` because the rows have different lifecycle (per-consumer-app vs per-fingerprint-database).
3. `pgserve create-app <slug>` CLI verb that writes the manifest + registers in `autopg_meta` + locks the cosign trust roots from `src/cosign/trust-list.js` at the moment of creation.
4. Manifest LOCK 1 verifier: a function called by `pgserve upgrade` (the existing verb) that verifies the new binary's cosign attestation matches one of the locked roots (not the current `TRUSTED_IDENTITIES` — operators control upgrade trust at create time, not at upgrade time). The trust-rotation primitive itself lives in `pgserve-singleton-no-proxy` G4 / `src/cosign/trust-list.js`; this group exercises the locked-roots path through rotation, NOT the rotation itself.
5. Tests for each module.

**Acceptance Criteria:**
- [ ] `pgserve create-app <slug>` is idempotent — second run with same slug touches `lastUpdated` and exits success.
- [ ] Manifest file is mode 0600; dir is mode 0700.
- [ ] `pgserve upgrade` against a binary signed by an identity NOT in the locked roots refuses with a clear error.
- [ ] `pgserve upgrade` against a binary signed by an identity IN the locked roots succeeds.
- [ ] Integration test covers the upgrade-after-trust-rotation case (operator rotates `TRUSTED_IDENTITIES` after create-app; the older slug still verifies against its frozen lock).

**Validation:**
```bash
bun test tests/cli/create-app.test.js tests/schema/autopg-meta.test.js tests/cosign/manifest-lock.test.js
bun run lint && bun run deadcode
```

**depends-on:** Group 2

---

### Group 4: Consumer migrations + v2.6 docs (Cutover G12-G18)
**Goal:** Every pgserve consumer (brain, omni, rlmx, hapvida-eugenia, email) gets an explicit migration recipe; v2.6 ships with operator-facing docs for every new surface.

**Scope split note:** `pgserve-singleton-no-proxy` G9 owns the **connectivity / fanout test** (`tests/integration/consumer-fanout.sh` proving brain/omni/rlmx/hapvida-eugenia/email can reach the new postmaster). This G4 owns only the **operator-facing migration recipes** (per-repo Markdown describing what those consumers' operators DO during the upgrade), the v2.6 CHANGELOG, and the `pgserve_meta` / trust-store reference docs. No connectivity-test work in this group.

**Deliverables:**
1. `docs/migrations/v2.6-from-v2.5.md` — what changed (new verbs + schema), what action operators take, rollback notes.
2. `docs/pgserve-meta.md` — schema reference; every column documented.
3. `docs/trust-store.md` — `~/.pgserve/trust/identities.json` schema + `pgserve trust` verb reference.
4. `CHANGELOG.md` v2.6 section: doctor / trust / gc / provision entries with one-line description each.
5. Per-consumer migration recipe (one Markdown file per repo) checked into each consumer's docs via PRs from this wish — operator-facing instructions only, NOT a connectivity test.
6. Update README's Quick Start section to reference the new verbs.

**Acceptance Criteria:**
- [ ] Each new doc compiles cleanly (no broken markdown links via a lint check).
- [ ] Every singleton verb has at least one example invocation in CHANGELOG or docs.
- [ ] Consumer repos have an open PR (or merged PR) referencing this wish slug — recipe-only PRs, not test-suite PRs.
- [ ] Migration recipe explicitly lists what NOT to change (avoid scope creep).
- [ ] Recipe text explicitly defers the "does it actually connect" verification to `pgserve-singleton-no-proxy` G9 / `tests/integration/consumer-fanout.sh`.

**Validation:**
```bash
markdownlint docs/ CHANGELOG.md README.md
grep -E "pgserve (doctor|trust|gc|provision)" CHANGELOG.md docs/
```

**depends-on:** Group 3

---

### Group 5: Final v2.4 validation + release prep (audit rotation + smoke)
**Goal:** Audit log rotation policy lands; end-to-end smoke against a fresh host proves the cohort holds together; v2.6 release is cut.

**Deliverables:**
1. Audit rotation in `src/gc/audit-log.js`: at start of every gc run, scan `~/.pgserve/audit/` for `gc-<YYYY-MM-DD>.log` files older than 90 days, delete them, audit each deletion with a `rotate` action.
2. End-to-end smoke script: `tests/integration/v2.6-cohort-smoke.sh` — fresh `mktemp` HOME → `npx pgserve@latest install` → `pgserve provision @demo/app` → workload → `pgserve gc --dry-run` → `pgserve doctor --json` (no FAIL) → cleanup.
3. Release notes for v2.6.0 capturing the cohort.
4. Tag + push v2.6.0 (or whatever the next semver is); release workflow handles GitHub Releases artifact upload + cosign signing (already shipped in PR #84).

**Acceptance Criteria:**
- [ ] Audit rotation deletes a synthetic 91-day-old log file but leaves a 89-day-old one.
- [ ] Rotation event itself is audited.
- [ ] Smoke script exits 0 on a clean Ubuntu 24.04 + macOS 14 host.
- [ ] `pgserve doctor --json` after the smoke shows zero FAIL findings.
- [ ] v2.6.0 release artifacts on GitHub Releases verify with `gh attestation verify` against the workflow OIDC identity.

**Validation:**
```bash
bun test tests/gc/audit-log.test.js  # adds rotation tests
bash tests/integration/v2.6-cohort-smoke.sh
gh attestation verify <downloaded-tarball> --owner namastexlabs
```

**depends-on:** Group 4

---

## Dependencies

| Direction | Wish | Group |
|-----------|------|-------|
| depends-on | `pgserve-singleton-no-proxy` | Groups 1-5 (foundation) |
| depends-on | `canonical-pgserve-pm2-supervision` | Group 1 (autopg lifecycle libraries) |
| blocks | `autopg-service-install-system` | (Tier B install — that wish is parked post-v2.4 and depends on G3's `autopg_meta` infrastructure) |

## QA Criteria

After all five groups merge to dev:

- [ ] `npx pgserve@<v2.6> install` on a clean macOS-arm64 + Ubuntu host works without manual fixup.
- [ ] `pgserve doctor --json` on the fresh install reports every check PASS or WARN — zero FAIL.
- [ ] `pgserve provision @demo/app` is idempotent across 10 concurrent runs (background jobs); exactly one DB + role + meta row.
- [ ] `pgserve gc --apply` on a synthetic orphan drops it and cleans the meta row; audit log captures every event.
- [ ] `pgserve trust list` shows the hardcoded roots; `pgserve trust add` + `remove` round-trips a user identity.
- [ ] `pgserve upgrade` against a binary outside the locked roots refuses; against a binary inside the locked roots succeeds.
- [ ] CHANGELOG and migration docs land before the v2.6 tag.

## Assumptions / Risks

- **Risk:** G3 `autopg_meta` schema design might collide with `pgserve_meta` semantics (both are per-consumer state). **Mitigation:** the wish-level decision (#5 above) gates G3 on a small design doc that maps `autopg_meta` ↔ `pgserve_meta` boundaries before any code lands.
- **Risk:** The integration test in G2 needs a real postgres in CI. **Mitigation:** matrix it as an optional job, not a hard gate, until we have GHA cache hits making it cheap.
- **Risk:** Consumer migration PRs in G4 may stall waiting on those repos' maintainers. **Mitigation:** open them as drafts early; cohort can ship v2.6 to npm even if consumer PRs land later in their own cadence.
- **Assumption:** No further bot-review CRITICAL findings on the singleton G3 PRs that just merged (#86–#92). If new ones surface, they get hot-fix PRs against main and don't block this wish.
- **Assumption:** GitHub Releases + Sigstore Rekor remain free + reliable for the 12-month window the cosign trust strategy assumes.
