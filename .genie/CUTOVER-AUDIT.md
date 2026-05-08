# autopg-distribution-cutover — Per-Group Status Audit

**Generated:** 2026-05-08
**Branch:** `wish/autopg-cutover-transport-absorb`
**Worktree:** `/home/genie/.genie/worktrees/pgserve/dream-cutover-audit`
**Wish:** `.genie/wishes/autopg-distribution-cutover/WISH.md` (20 groups: G1–G18 + G19/G20)
**Auditor:** engineer (read-only; no code modified)

---

## Summary

**6 / 20 DONE, 5 / 20 PARTIAL, 9 / 20 NOT-STARTED.**

- **DONE:** G1, G2, G3, G6, G9, G10
- **PARTIAL:** G4 (missing issue-54 leak repro fixture), G5 (1 manifest-verify test failing), G7 (CI matrix bytes pending dispatch), G8 (real SLSA L3 only in CI), G11 (multiple deliverables added 2026-05-08 not in commit)
- **NOT-STARTED:** G12, G13, G14, G15, G16, G17, G18, G19, G20

**Critical-path-to-ship gaps:**
1. **G11 admin.json supervisor write** (deliverable 2 added 2026-05-08) — blocked by cross-wish dependency on `pgserve-singleton-no-proxy` G1 (`src/lib/admin-json.{ts,js}` writer module). G11 commit pre-dates this contract.
2. **G11 pm2 process name mismatch** — implementation uses `autopg`, wish requires `autopg-server` (paired with `autopg-ui`). Plus missing migration-from-legacy step (delete `pgserve` / `autopg` pm2 entries before writing `autopg-server`).
3. **G19 `autopg serve` dual-transport binding + `runtime.json`** — entirely NOT-STARTED. New 2026-05-08 group; wish references it as the canonical UDS discovery contract that genie + omni consume. Blocks G12 (`autopg update` depends-on G19) and downstream consumers.
4. **G20 `autopg service install` Tier B systemd-user / launchd** — entirely NOT-STARTED. New 2026-05-08 group. Hard-MIGRATE contract from pm2 → systemd-user/launchd is locked but unimplemented. Blocks G18 cutover validation matrix.
5. **G4 issue-54 leak repro fixture missing** — wish acceptance criterion explicitly demands `bash test/integration/issue-54-leak-repro.sh` exists and proves zero leaked backends. No such fixture in repo; commit body asserts the leak class is gone but provides no automated test.
6. **G5 manifest-verify test failure** — `verifyManifest — missing publisher key > throws ENOPUBKEY when no key resolvable` fails on the current branch. LOCK 1 cosign verifier should reject when no publisher key resolvable; failing test is a regression that must close before G5 can be called done.
7. **G12–G18 sequence** — entirely unimplemented. G12 (autopg update 13 stages) depends on G11+G19; G13 (genie consumer migration) depends on G19; G14 (omni) chains from G13; G15 (npm advisory) from G12; G16 (docs) from G14; G17 (SHARED-DESIGN lint) from G16; G18 (Felipe-host validation + sentinel) from G17. Long serial tail.

---

## Per-Group Status Table

| Group | Commit(s) | Status | Gap (file:line + exact change required) |
|-------|-----------|--------|-----------------------------------------|
| **G1** Admin SCRAM bootstrap | `c72dab8` | **DONE** | `src/auth/admin-bootstrap.js` ships full bootstrap + idempotent skip + `postgres` role lockdown (NOLOGIN/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS) at line 130–146; wired into `src/postgres.js:693` after `_initAdminPool()`; secret file written 0600 via atomic-rename (`writeSecretFile` line 64). Tests `tests/auth/admin-bootstrap.test.js` 7/7 pass. |
| **G2** pg_hba B1 rewrite | `ba8be47` | **DONE** | `src/auth/pg-hba-template.js` emits B1-fixed layout (zero `trust`); `pg_ident.conf` co-managed (peer→`autopg_admin` map); `migratePgHba()` overwrites legacy template + SIGHUP reload; CI smoke parses output and asserts no `\btrust\b` lines. Wired in `src/postgres.js` `_rewritePgHba()` after `_bootstrapAdmin()`. Tests `tests/auth/pg-hba.test.js` 27/27 pass. |
| **G3** Schema rename + autopg_apps DDL | `444e413` | **DONE** | `src/upgrade/steps/100-rename-meta.js` (uses `ALTER TABLE … SET SCHEMA` because `pgserve_meta` is a *table* in `public`, not a schema — wish description was inaccurate but outcome is correct), `101-autopg-apps-ddl.js`, `102-pgserve-symlink-compat.js` registered in `src/upgrade/index.js`; idempotent on all paths. Tests 22/22 pass. **Minor wish-doc note:** wish G3 §1 prescribes `ALTER SCHEMA pgserve_meta RENAME TO autopg_meta` but the actual layout has `public.pgserve_meta` as a table — implementation is correct, wish text needs a one-line correction. |
| **G4** Delete 7 proxy modules (≥2,706 LOC) | `e03ba09` | **PARTIAL** | Deletes 8,138 LOC across 32 files (well above 2,706 target); `src/pg-wire.js`, `src/protocol.js`, `src/daemon-control.js`, `src/router.js`, `src/daemon-tcp.js`, `src/sdk.js`, `src/cluster.js`, `src/restore.js` all removed; `bun test` clean. **GAP:** wish acceptance criterion 4 (`bun test && bash test/integration/issue-54-leak-repro.sh`) requires a fixture at `tests/integration/issue-54-leak-repro.sh` proving zero leaked backends after 60+ conn/s for 30 min. **No such fixture exists** (`ls tests/integration/` shows only cdn-publish, install-binary, install-sh-fresh-host, sign-attest-smoke, tarball-smoke). Action: create `tests/integration/issue-54-leak-repro.sh` driving the connect/disconnect loop and asserting `pg_stat_activity` deltas. |
| **G5** create-app/list/revoke/rotate + manifest LOCK 1 | `d6e7e64` | **PARTIAL** | All 4 verbs ship in `src/cli/autopg.js` (660 lines); `schemas/autopg.json.v1.json` matches wish §G5 deliverable 2 exactly; `src/auth/manifest-verify.js` (186 lines) LOCK 1 verifier with `--unsafe-unverified` bypass + audit row; atomic env-file writer `src/cli/env-file-writer.js` (write-tmp→fsync→rename→fsync-parent, 0600/0700). 24/25 tests pass. **GAP:** `tests/auth/manifest-verify.test.js` test `verifyManifest — missing publisher key > throws ENOPUBKEY when no key resolvable` **fails** on current branch (5008ms timeout). Fix the verifier so absent publisher key yields a fast `ENOPUBKEY` rather than hanging — likely a missing throw path in the cosign-key resolver fallback chain (`src/auth/manifest-verify.js` line ~76/107/166–169 per coverage uncovered set). |
| **G6** Audit + redaction lint | `7837375` | **DONE** | New op-keyed emitter `src/audit/audit.js` (100% coverage); `auditEmit({op,app,role,actor,manifestSha256,sigVerified,incidentId?})` JSON-Lines to `~/.autopg/logs/audit.log` (mode 0600, parent 0700); `scripts/audit-redaction-lint.js` AST-walks 42 files, 0 issues. `bun run lint:audit` wired. Tests `tests/audit/audit.test.js` 13/13 pass. **Minor note:** legacy event-keyed `src/audit.js` co-exists; G1/G2/G3 still emit through it. Two emitters is intentional per commit body but worth flagging for future consolidation. |
| **G7** bun build --compile + postgres bundle | `04fd343` | **PARTIAL** | `scripts/build-binary.sh` (211 lines) + `scripts/fetch-postgres-bins.sh` (227) + `scripts/assemble-tarball.sh` (187) + `.github/workflows/build-tarballs.yml` (191) + `tests/integration/tarball-smoke.sh` (232) ship full shape. Smoke fixtures pass 11/11 per platform per commit body. **GAP (acknowledged in commit):** the bytes-level acceptance bullets (50–80 MB tarball size, real `autopg --version` printing `autopg 2.260503.1`, real `postgres --version` printing 16.x, CI matrix green across 5 platforms) only land when the dispatch matrix runs against a tag. Action: trigger the GH Actions workflow on a tag (`autopg-v2.260503.1` candidate) and capture artifacts. |
| **G8** cosign sign + SLSA L3 attest | `f3c92a4` | **PARTIAL** | `.github/workflows/sign-attest.yml` (285) + `scripts/aggregate-manifest.sh` (184) + `scripts/verify-published-artifacts.sh` (211) + `keys/cosign.pub` + offline test fixtures + `tests/integration/sign-attest-smoke.sh` (15/15 pass). Tampered + missing-sig paths both fail correctly with non-zero exit. **GAP:** real SLSA L3 only when GH OIDC fires in CI (depends on G7 binaries + tag dispatch). Workflow wired but not yet executed end-to-end. |
| **G9** CDN publish | `e187c0d` | **DONE** *(local fixture)* / partial against real CDN | `scripts/cdn-publish.sh` + `.github/workflows/cdn-publish.yml` + `tests/integration/cdn-publish.sh` (38/38 pass): immutable contract on `<channel>/<version>/`, atomic `latest.json`, immutable re-publish blocks (exit 3), `--allow-overwrite-versioned` escape hatch, dry-run zero-touch, cosign.pub published. **No gap on shape**; real-CDN acceptance bullets (`curl https://cdn.automagik.dev/autopg/stable/latest.json`) wait on G7+G8 tag dispatch. |
| **G10** install.sh ≤80 lines | `8e068f1` | **DONE** | `install.sh` is **79 lines**, shellcheck-clean (0 warnings), `tests/integration/install-sh-fresh-host.sh` (309 lines) 9/9 pass: happy-path verify+extract+exec, sha256 tamper abort, Windows-native locked rejection. Reads channel pointer from `AUTOPG_CDN_BASE`. End-to-end-on-real-host acceptance ("`curl … \| bash` <60s") gated on G9 real publish. |
| **G11** autopg install (Tier A pm2) | `7e04f7b` | **PARTIAL** | `src/cli/install.js` (450 lines) ships 5 of the wish deliverables: config.json write, `~/.local/bin/autopg` symlink, idempotent PATH export to `~/.bashrc`+`~/.zshrc`, bash+zsh completions, pm2 register. Tests 25/25 unit + 6/6 integration pass. **GAPS (multiple — most introduced by 2026-05-08 wish refinement):** <br/>1. **pm2 process name** — `src/cli/install.js:41` defines `PM2_PROCESS_NAME = 'autopg'`; wish §G11 deliverable 1 mandates **`autopg-server`** (paired with `autopg-ui`). Rename the constant + update tests. <br/>2. **Legacy pm2 entry migration** — wish §G11 deliverable 1 requires detecting a pre-existing pm2 entry named `pgserve` *or* `autopg` (early-cutover variant) and `pm2 delete` it before creating `autopg-server`. Current `src/cli/install.js` line 406 short-circuits when an entry called `autopg` exists; no migration. <br/>3. **`~/.autopg/admin.json` cohort supervisor write** — wish §G11 deliverable 2 (added 2026-05-08) requires invoking the writer from `pgserve-singleton-no-proxy` G1 (`src/lib/admin-json.{ts,js}`) after pm2 register, writing `{supervisor:"pm2",socketDir,port:5432,installedAt:<ISO8601>}`. **Module does not exist yet** (`find src -name 'admin-json*'` → 0 hits); cross-wish dependency on the cohort sibling. <br/>4. **Tier-B refusal** — wish §G11 acceptance bullet 8: on a host where `~/.autopg/admin.json.supervisor == "systemd-user"`, `autopg install` must exit non-zero with locked remediation hint. Not implemented. <br/>5. **First-run admin SCRAM bootstrap hook** — wish §G11 deliverable 1 §6 says install.js should "invoke admin SCRAM bootstrap (Group 1)"; commit defers this to `src/postgres.js` daemon-process wiring with a justification ("we tolerate its absence here"). The acceptance criterion *is* met indirectly because pm2 starts the daemon which fires bootstrap, but this is fragile if pm2 is unavailable. Defensive-double-fire per D12 means both call sites should fire — one from install.js immediate-path, one from postgres.js boot-path. |
| **G12** autopg update — 13 stages | — | **NOT-STARTED** | No commits. Depends on G11 + G19. SHARED-DESIGN.md §4.2 contract (13-stage pipeline + tagged-union `VerifyResult` + cleanup-registry + `pgserve update` alias) needs full implementation in `src/cli/update.js` + `src/cli/legacy-cleanup.js` + `schemas/update-diagnostics.v1.json`. |
| **G13** Genie consumer migration | — | **NOT-STARTED** | Cross-repo work. `automagik-dev/genie` PR opens `autopg.json` at repo root + reads creds from `~/.autopg/genie.env` + uses `resolvePgserveTransport()` (already shipped at genie #1667 per wish). Felipe-host adopt-existing-db prompt. genie release pipeline cosign-signs `autopg.json`. Depends on G5+G19+G12. |
| **G14** Omni consumer migration + release pipelines | — | **NOT-STARTED** | Cross-repo work in `automagik-dev/omni`. `packages/api/autopg.json` + `_buildConnection` reads `~/.autopg/omni.env` + chained `legacy-data-migration.ts` + cosign-sign in BOTH genie+omni release pipelines + CI lint blocking missing sig. Depends on G5+G12+G13. |
| **G15** Final pgserve@2.260503.0 npm advisory | — | **NOT-STARTED** | One-line `bin/pgserve.js` exits 2 with curl install hint; new npm publish gated on `pgserve-final-v*` tag. Depends on G12. |
| **G16** Docs + migration guide unified | — | **NOT-STARTED** | `docs/migration/from-pgserve-2.2-to-autopg-2.260503.md` + per-consumer sections + trust-boundary explainer + CHANGELOG D3 text in all 3 repos + `scripts/changelog-trust-boundary-lint.sh`. Depends on G14. |
| **G17** SHARED-DESIGN.md byte-equality CI lint | — | **NOT-STARTED** | `scripts/shared-design-byte-equality.sh` cross-repo `gh`-fetch + diff + LF-normalize. CI step in pgserve+genie+omni. Depends on G16. |
| **G18** Cutover validation — Felipe-host + doctor 11/11 + sentinel signoff | — | **NOT-STARTED** | `scripts/cutover-validation.sh` + `autopg doctor` 11-check matrix + council-final-cutover sentinel signoff at `brain/_decisions/autopg-cutover-sentinel-signoff.md`. Depends on G17. |
| **G19** `autopg serve` — dual-transport + `runtime.json` | — | **NOT-STARTED** | New 2026-05-08 group. `src/cli/serve.js` resolves `$XDG_RUNTIME_DIR/autopg/` (or `/tmp/autopg/` fallback), spawns embedded postgres with `-k <canonical-socket-dir>` + `-h 127.0.0.1` + `--port`, writes `<canonical>/runtime.json` (NOT `admin.json` — collision-renamed per /review 2026-05-08), cleans on SIGTERM, leaves on crash. `~/.pgserve/` legacy symlink-compat. Cross-wish depends-on `pgserve-singleton-no-proxy` G1 (postmaster `-k <socketDir> -p 5432` + dual-transport). |
| **G20** `autopg service install` — Tier B systemd-user / launchd | — | **NOT-STARTED** | New 2026-05-08 group. `src/cli/service-install.js` implementing hard-MIGRATE contract: Tier-A `pm2 stop`+`pm2 delete`+verify-empty → write systemd user-unit (Linux) or LaunchAgent plist (macOS) → enable+start+verify → update `~/.autopg/admin.json.supervisor`. Rollback path on failure. `--system` mode rejected with locked text. `autopg service uninstall` reverse migration. `autopg doctor` extension reads `admin.json.supervisor` and dispatches matching liveness check (passive, no auto-swap). Cross-wish depends-on `pgserve-singleton-no-proxy` G1 (`src/lib/admin-json.js` writer). |

---

## Validation Evidence

All commands run from `/home/genie/.genie/worktrees/pgserve/dream-cutover-audit`.

| Group | Command | Outcome |
|-------|---------|---------|
| G1 | `bun test tests/auth/admin-bootstrap.test.js` | 7 pass / 0 fail (235 expects, 1.75s) |
| G2 | `bun test tests/auth/pg-hba.test.js` | 27 pass / 0 fail (53 expects, 8.45s) |
| G3 | `bun test tests/upgrade/100-rename-meta.test.js tests/upgrade/101-autopg-apps-ddl.test.js tests/upgrade/102-pgserve-symlink-compat.test.js` | 22 pass / 0 fail (76 expects, 74ms) |
| G4 | `ls tests/integration/issue-54-leak-repro.sh` | **MISSING** — fixture not in repo |
| G5 | `bun test tests/cli/{create-app,list,revoke,rotate}.test.js tests/auth/manifest-verify.test.js` | 24 pass / **1 fail** (manifest-verify ENOPUBKEY, 5008ms) |
| G6 | `bun test tests/audit/audit.test.js && bun run lint:audit` | 13/13 + 0 lint issues across 42 files |
| G7 | (smoke fixtures asserted in commit body; bytes pending CI dispatch) | shape-only |
| G8 | `bash tests/integration/sign-attest-smoke.sh` | 15 pass / 0 fail |
| G9 | `bash tests/integration/cdn-publish.sh` | 38 pass / 0 fail |
| G10 | `wc -l install.sh && shellcheck install.sh && bash tests/integration/install-sh-fresh-host.sh` | 79 lines, 0 warnings, 9 pass / 0 fail |
| G11 | `bun test tests/cli/install.test.js && bash tests/integration/install-binary.sh` | 25 pass + 6 pass (A1–A6); deliverables 2–5 of wish §G11 absent |

---

## Dispatch Recommendations (/dream Layer 3)

### Round 1 — fix-first on existing PARTIALs (parallel-safe, zero new file conflicts)

1. **G5-fix** — single test failure in `tests/auth/manifest-verify.test.js` (ENOPUBKEY-when-no-key-resolvable). Touch only `src/auth/manifest-verify.js` and the test. ETA <30 min. **Highest leverage** because it unblocks the LOCK 1 verifier guarantees that downstream consumers depend on.
2. **G4-fixture** — author `tests/integration/issue-54-leak-repro.sh`. Drives 60+ conn/s connect/disconnect loop against a fresh-host autopg, audits `pg_stat_activity` for orphan backends, exits non-zero on leaked count > 0. Touch tests/integration only.
3. **G11-rename** — rename pm2 process from `autopg` to `autopg-server` in `src/cli/install.js:41` + `tests/cli/install.test.js` + `tests/integration/install-binary.sh` + USAGE strings. Add legacy pm2 cleanup branch (`pm2 delete pgserve`+`pm2 delete autopg` if found). Strict-scope; small diff. Skip the admin.json deliverables in this pass — those are blocked on the cohort sibling.

### Round 2 — new groups (start once Round 1 lands)

4. **G19** — `autopg serve` dual-transport. Highest sequencing value because **G12, G13, and G14 all depend on it**. Single-file primary (`src/cli/serve.js`) + 1 test file + 1 integration script. Cross-wish blocker: needs `src/lib/admin-json.{ts,js}` writer module from `pgserve-singleton-no-proxy` G1. Coordinate dispatch so cohort sibling lands first or co-ships.
5. **G11-admin.json** — once `pgserve-singleton-no-proxy` G1 ships its `src/lib/admin-json.js` writer, return to G11 and add deliverable 2 (cohort supervisor write + Tier-B refusal). Trivial diff (< 50 LOC) but dependency-ordered.

### Round 3 — depend on G11 / G19

6. **G20** — `autopg service install` Tier B. Sibling to G11. Same `src/lib/admin-json.js` cohort writer dependency. Hard-MIGRATE contract is intricate; allocate most context budget here. Single dispatch, no parallelism with G11 because both touch `admin.json.supervisor`.
7. **G12** — `autopg update` 13-stage pipeline. Long but straightforward: implements SHARED-DESIGN.md §4.2 byte-for-byte, uses cleanup-registry pattern. Touch `src/cli/update.js` + `src/cli/legacy-cleanup.js` + `schemas/update-diagnostics.v1.json`. No file overlap with G19/G20.

### Round 4 — consumer migrations (cross-repo)

8. **G13** + **G14** — both cross-repo (genie + omni). G13 first (genie ships `autopg.json` + `_buildConnection` change), then G14 (omni mirrors + chains migration logic). Cosign signing wired into both release pipelines. Coordinate with `automagik-dev/genie` and `automagik-dev/omni` maintainers — these are PRs in their repos, not this one.

### Round 5 — release tail

9. **G15** (npm advisory) → **G16** (docs) → **G17** (SHARED-DESIGN lint) → **G18** (Felipe-host validation + sentinel signoff). Strictly serial. G17 is small (a script + 3 CI step adds); G18 is the largest because it requires Felipe-host execution + council convening.

### Cross-wish coordination notes

- **`pgserve-singleton-no-proxy` G1** is the gating cohort sibling for G11 deliverable 2, G19, and G20. Confirm its status before dispatching Round 2/3.
- **`canonical-pgserve-pm2-supervision`** is the sibling that documents cross-repo pm2 reuse (genie install / omni install consume admin.json contract from G11). Tier-A only. Should ship in parallel with G11 fix-first.
- **`distribution-exodus` G1/G2** (cosign + CDN infra) appears already absorbed via G7/G8/G9 commits and the sign-attest workflow; verify the upstream wish is closed before tagging.

---

*End of audit. Generated by engineer (read-only). No source files modified during audit.*
