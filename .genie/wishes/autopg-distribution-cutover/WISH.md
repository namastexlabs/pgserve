# Wish: autopg distribution cutover — rename, sign, ship via CDN

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `autopg-distribution-cutover` |
| **Date** | 2026-05-03 |
| **Author** | Felipe Rosa <felipe@namastex.ai> (drafted via felipe-personal-agent) |
| **Appetite** | XL (~4–5 weeks parallel; ~6–8 sequential) |
| **Branch** | `wish/autopg-distribution-cutover` |
| **Repos touched** | `namastexlabs/pgserve` (renames to `automagik-dev/autopg`) |
| **Design** | _No brainstorm — direct wish_ |
| **Supersedes** | `pgserve/autopg-v22` (DRAFT, never started); `pgserve/autopg-pairing` (DRAFT, abandoned post-council 2026-05-01) |
| **Absorbs** | the never-drafted `pgserve/add-update-command` sibling (referenced in SHARED-DESIGN.md but never written) |
| **Council** | `council-1777663000` (autopg-pairing pressure-test, 2026-05-01) |

> **Companion document:** [SHARED-DESIGN.md](./SHARED-DESIGN.md) — cross-CLI unification spec.
> The same shape ships in two sibling wishes: `automagik-dev/genie #update-unify-stages` and `automagik/omni #update-unify-stages`. SHARED-DESIGN.md is byte-identical across the three repos and CI enforces drift-prevention (Group 17).

## Summary

Cut **autopg `2.260503.1`** as the rename + distribution-cutover ship line. Renames `pgserve` → `autopg`, deletes the 7 wrapper-proxy modules (~2,706 LOC verified) so issue #54's leak class ceases to exist as a code path, and replaces npm publishing with cosign-signed tarballs published to `cdn.automagik.dev/autopg/<channel>/<version>/<platform>/`. Each app gets per-app role + per-app DB + scoped GRANT + SCRAM password, declared via signed `autopg.json` manifest (LOCK 1 cosign-verified at provision time), credential delivered via `~/.autopg/<app>.env` (mode 0600). The `autopg update` command implements the 13-stage pipeline locked in `SHARED-DESIGN.md` (shared shape across genie/omni/autopg). Final `pgserve@2.260503.0` npm release is a one-line advisory that exits 2 with curl-install hint. Trust boundary = host UID, named in CHANGELOG. LOCK 2 + auth.sock pairing infrastructure stays deferred to v2.4-equivalent with named-threat trigger.

## Scope

### IN

- Project rename `pgserve` → `autopg` (binary, config dir `~/.pgserve` → `~/.autopg` with one-milestone backward-compat symlink, env var prefixes).
- Schema rename `pgserve_meta` → `autopg_meta` via idempotent ALTER TABLE.
- Code deletion ~2,706 lines verified: `pg-wire.js` (869), `protocol.js` (389), `daemon-control.js` (468), `router.js` (546), `daemon-tcp.js` (297), `sdk.js` (137) + ~150 proxy bits in `daemon.js`.
- Admin SCRAM bootstrap `~/.autopg/admin.secret` (mode 0600) — replaces `postgres:postgres` plaintext.
- `pg_hba.conf` B1-fixed layout (peer-auth admin + scram-only catch-all; **NO `local … all trust`** for any user predicate per Sentinel B1).
- `autopg create-app` / `list` / `revoke` / `rotate` CLI verbs.
- `autopg.json` manifest schema (light-touch v1: `app`, `needs.{database, extensions, privileges, quotas}`, **NO `publisher_sig` field yet** — see G5 for cosign LOCK 1 add).
- LOCK 1 cosign-verify on `autopg.json` before provisioning (uses cosign keyless infra from `genie-supply-chain-signing`).
- `--adopt-existing-db <name>` flag for `create-app` (Felipe-host data-preservation case).
- `bun build --compile` static binaries for 5 platforms (Linux x86_64 glibc/musl, Linux arm64, macOS x86_64/arm64) — fallback to `pkg`/`nexe` if bun fails per `distribution-exodus` G1.
- All-in-one tarball per platform: autopg cli + postgres binaries bundled (~60MB).
- cosign keyless OIDC sign + SLSA L3 attest per-platform tarball.
- CDN publish to `cdn.automagik.dev/autopg/<channel>/<version>/<platform>/` (channels: `stable`, `beta`, `canary`).
- `install.sh` ≤80 lines: `ensure_bun` + `ensure_pm2` + `ensure_curl` + download `manifest.json` + verify SHA256 + verify cosign sig + verify SLSA provenance + extract tarball + handoff to `autopg install --non-interactive`.
- `autopg install` binary subcommand: pm2 register + `~/.local/bin/autopg` symlink + rc-file PATH edit + completions.
- `autopg update` 13-stage pipeline per SHARED-DESIGN.md §4.2 (`resolveChannel`, `checkLatestVersion`, `shortCircuitIfCurrent`, `confirmIfTTY`, `detectInstallers`, `installPrimary`, `installSecondary`, `syncArtifacts`, `restartServicesIfRunning`, `verifyOrFail`, `postUpdateMaintenance`, `captureDiagnostics`, `successBanner`).
- Cleanup-registry entries for autopg's `cleanupLegacyArtifacts()`: legacy embedded pgserve dirs (`~/.pgserve/data/*` after rename), stale postmaster ports, orphan `postmaster.pid`, legacy `~/.pgserve` config dir (after symlink-compat window).
- Diagnostics JSON `~/.autopg/logs/update-diagnostics-<iso>.json` `schemaVersion: 1` (autopg's first; asymmetric per SHARED-DESIGN.md §4.4).
- Back-compat alias: `pgserve update` works for one milestone, prints stderr deprecation hint pointing to `autopg update`.
- Genie consumer migration: ships `autopg.json` at root, signed by namastex publisher key in CI; `_buildConnection` reads `DATABASE_URL` from `~/.autopg/genie.env`.
- Omni consumer migration: ships `packages/api/autopg.json`, same pattern + chains existing `legacy-data-migration.ts` pattern (FK trigger bypass via `SET session_replication_role = replica` + per-table COPY + schema-drift abort) for data-preservation when post-rename canonical detected empty.
- Genie + omni release pipeline extension: cosign-sign the published `autopg.json` (LOCK 1 source-of-trust). Without this, `autopg create-app`'s verify side has nothing to verify against.
- Final `pgserve@2.260503.0` npm advisory release: `console.error("npm publishing discontinued — install via curl https://get.automagik.dev/autopg | bash"); process.exit(2);`.
- SHARED-DESIGN.md byte-equality CI lint across the 3 sibling repos (genie/omni/pgserve).
- CHANGELOG must contain exact text: *"autopg trust boundary = host UID. Intra-UID isolation is out of scope; multi-tenant hosts requiring intra-UID separation must wait for the LOCK 2 + auth.sock release."*

### OUT

- LOCK 2 HMAC host-binding (deferred to v2.4-equivalent with named-threat trigger).
- `~/.run/autopg/auth.sock` `IssueCredentials` RPC (deferred — env-file is the contract for now).
- `autopg_dev_zone` database (Sentinel B1: trust-auth dev zone is a security regression).
- DBA agent automation (no pairings to review yet).
- Cross-host pairing portability / org-wide CA (v2.4+).
- Migration of brain, rlmx, hapvida-eugenia, email consumers (per-app wishes after autopg ships).
- Web dashboard for `autopg auth list` (deferred per `autopg-v22` OUT).
- Source-install path (autopg is binary-only post-cutover).
- `src/postgres.js` modifications (1,507 lines verified subprocess orchestration; nothing to gut per `autopg-v22` §6).
- Windows native support (WSL only; install.sh rejects bare Windows with helpful message).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Control plane only — autopg never in the byte path | Felipe directive "PG is king"; council unanimous. |
| D2 | Native postgres primitives only | Felipe "don't reinvent the wheel". |
| D3 | Trust boundary = host UID, named in CHANGELOG | Sentinel ship-condition; honest threat-model. |
| D4 | Per-app role + per-app DB + scoped GRANT + SCRAM | Replaces "free postgres:postgres" without rebuilding pairing. |
| D5 | Credential via `~/.autopg/<app>.env` (mode 0600) | Kernel-enforced file perms; no RPC to harden. |
| D6 | NO `local … all trust` in `pg_hba` | Sentinel B1: superuser-as-a-service via pg_hba first-match. |
| D7 | Bearer-token md5 compat shim through this milestone | Existing v2.1.x consumers must keep working during cutover. |
| D8 | Schema is `ALTER TABLE`, not greenfield `CREATE` | Existing rows must survive. |
| D9 | LOCK 2 + auth.sock deferred with named-threat trigger | Council convergence; trigger = real intra-UID isolation need (CI runners, multi-tenant). |
| D10 | npm exodus = soft cut (Brainstorm Topic 1 = B) | Final advisory `pgserve@2.260503.0` release exits 2 with curl hint. |
| D11 | CalVer `2.YYMMDD.N` (Brainstorm Topic 2) | Three-CLI consistency; CalVer survives semver-trap by design (lexicographic = chronological). |
| D12 | Both `install.sh` AND `autopg update` fire upgrade migration (Topic 3 = C) | Defensive, idempotent steps survive double-fire. |
| D13 | One mega wish, no `add-update-command` split (Topic 4 = C) | Same code surface; splitting wastes review cycles. |
| D14 | LOCK 1 cosign manifest signing IN scope (Topic 5 = YES) | Cosign infra exists for free via `supply-chain-signing`; near-zero extra cost. |
| D15 | All-in-one tarball: autopg cli + postgres bins (Topic 6 = C) | Single signed artifact = single verification = simplest mental model. |
| D16 | `install.sh` installs prereqs: bun + pm2 + curl (Topic 7) | Bootstrap-only contract per `update-unify-stages` D5. |
| D17 | Independent code per CLI, no shared package | SHARED-DESIGN.md recommendation §3. |
| D18 | PRs target `dev` | agent-bible §1. |
| D19 | Diagnostics `schemaVersion` asymmetric per CLI; autopg starts at `1` | SHARED-DESIGN.md §4.4. |
| D20 | `autopg update` default = TTY confirmation prompt (matches omni) | Brand-new command; safer default for daemon restart. |
| D21 | Sequencing = parallel with genie+omni `update-unify-stages` siblings | Default — verify with Felipe if doubt. |
| D22 | SHARED-DESIGN.md byte-equality CI lint enforced | Single source of truth across 3 repos. |

## Success Criteria

- [ ] **S1** — `autopg 2.260503.1` published to `cdn.automagik.dev/autopg/stable/`.
- [ ] **S2** — `pgserve@2.260503.0` published to npm with one-line body that exits 2.
- [ ] **S3** — `curl -fsSL https://get.automagik.dev/autopg | bash` produces working daemon + paired schema in <60s on a clean host.
- [ ] **S4** — `autopg create-app omni && autopg create-app genie` provisions both consumers; both connect via SCRAM with their per-app role to their owned DB.
- [ ] **S5** — Zero `postgres:postgres` plaintext anywhere on host post-install (`grep -r 'password.*postgres' ~/.autopg/ src/` returns 0 hits).
- [ ] **S6** — Issue #54 reproduction (sustained 60+ conn/s for 30 min) shows zero leaked backends — `pg_stat_activity` query in audit log confirms.
- [ ] **S7** — Code metrics: ≥2,700 lines deleted from `src/`; remaining `src/` has zero references to deleted modules.
- [ ] **S8** — `cosign verify` succeeds on every published platform binary; `slsa-verifier verify-artifact` succeeds against provenance.
- [ ] **S9** — `cosign verify` on `autopg.json` rejects unsigned manifest with clear *"manifest unsigned. add publisher sig or pass `--unsafe-unverified <INCIDENT_ID>`"* error.
- [ ] **S10** — `--adopt-existing-db genie` on Felipe-host: cli connects to canonical `genie` DB with the migrated 2869 tasks visible.
- [ ] **S11** — `autopg update` 13-stage pipeline matches SHARED-DESIGN.md byte-for-byte: same flags, same exit codes, same `VerifyResult` tagged-union.
- [ ] **S12** — SHARED-DESIGN.md byte-equality across `genie/omni/pgserve` copies enforced by CI lint; deliberate drift fails the build.
- [ ] **S13** — `pgserve update` alias prints exact stderr deprecation: *"`pgserve update` is deprecated. Run `autopg update` instead. This alias works for one milestone."* and proceeds normally.
- [ ] **S14** — CHANGELOG contains exact trust-boundary text (D3); CI lint blocks release if absent.
- [ ] **S15** — Existing `pgserve@2.2.1` host upgrades to autopg `2.260503.1` without losing per-app DBs (verified via per-fingerprint table count before/after).
- [ ] **S16** — Council sentinel signs off on threat model post-implementation.

## Execution Strategy

This wish ships in six waves. Wave 1 is sequential (auth foundation must land coherently). Waves 2–5 run with internal parallelism gated by per-group `depends-on`. Wave 6 is sequential (validation gate before release).

### Wave 1 — Foundation (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Admin SCRAM bootstrap (`~/.autopg/admin.secret` 0600). |
| 2 | engineer | `pg_hba.conf` B1-fixed rewrite (peer + scram only, NO `trust`). |
| 3 | engineer | Schema rename `ALTER pgserve_meta → autopg_meta` + `autopg_apps` DDL. |
| 4 | engineer | Delete 7 proxy modules (~2,706 LOC verified). |

### Wave 2 — Identity + manifest (parallel after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | `autopg create-app/list/revoke/rotate` + `autopg.json` schema + LOCK 1 cosign verify before provisioning + `--adopt-existing-db` flag. |
| 6 | engineer | Audit + redaction lint. |

### Wave 3 — Distribution (parallel after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | `bun build --compile` static binaries (5 platforms) + bundle postgres bins. |
| 8 | engineer | cosign keyless OIDC sign + SLSA L3 attest per-platform tarball. |
| 9 | engineer | CDN publish (`cdn.automagik.dev/autopg/<channel>/<version>/<platform>/`). |
| 10 | engineer | `install.sh` ≤80 lines: `ensure_bun` + `ensure_pm2` + `ensure_curl` + download + verify + handoff. |
| 11 | engineer | `autopg install` (binary subcommand) — pm2 register + paths + rc-file edit. |

### Wave 4 — Update pipeline (depends on Wave 3 + sibling SHARED-DESIGN.md)

| Group | Agent | Description |
|-------|-------|-------------|
| 12 | engineer | `autopg update` 13-stage pipeline per SHARED-DESIGN.md + cleanup-registry entries + diagnostics `schemaVersion: 1` + back-compat `pgserve update` alias. |

### Wave 5 — Consumer migration (parallel after Waves 2 + 4)

| Group | Agent | Description |
|-------|-------|-------------|
| 13 | engineer | Genie consumer: `DATABASE_URL` from `~/.autopg/genie.env` + signed `autopg.json`. |
| 14 | engineer | Omni consumer: same + chain `legacy-data-migration` pattern + genie release pipeline cosign-sign + omni release pipeline cosign-sign. |
| 15 | engineer | Final `pgserve@2.260503.0` npm advisory (exit-2 + curl install hint). |

### Wave 6 — Release + validation (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 16 | docs | Documentation + migration guide unified across genie/omni/autopg. |
| 17 | engineer | SHARED-DESIGN.md byte-equality CI lint across the 3 sibling repos. |
| 18 | qa | Cutover validation: Felipe-host runs full path, doctor 11/11, council sentinel signs. |

---

## Execution Groups

### Group 1: Admin SCRAM bootstrap

**Goal:** Replace the `postgres:postgres` plaintext default with a SCRAM-authenticated admin role whose password is generated at first-boot and stored at `~/.autopg/admin.secret` (mode 0600).

**Deliverables:**
1. New `src/auth/admin-bootstrap.js`: generate 32-byte URL-safe token at first-boot if `~/.autopg/admin.secret` absent; write file with `mode: 0o600`; create `autopg_admin` SCRAM role; revoke superuser from default `postgres` role (keep role for compatibility; revoke privileges only).
2. Idempotent on re-run — if secret file exists, do nothing; if role exists with matching SCRAM verifier, do nothing.
3. Wired into existing `src/postgres.js` first-boot sequence (after `initdb`, before `pg_hba` install).
4. Audit log entry: `admin-bootstrap: created` / `admin-bootstrap: idempotent-skip`.

**Acceptance Criteria:**
- [ ] Fresh-host install creates `~/.autopg/admin.secret` with `0600` perms and no default `postgres:postgres` row reachable.
- [ ] Re-running `autopg start` on an existing host does NOT rotate the admin secret (idempotent).
- [ ] `psql -h localhost -U autopg_admin -d postgres` succeeds with the password in `admin.secret`.
- [ ] `psql -h localhost -U postgres -d postgres` either fails or has no privileges beyond `pg_read_server_files`.

**Validation:**
```bash
bun test test/auth/admin-bootstrap.test.js
```

**depends-on:** none

---

### Group 2: pg_hba.conf B1-fixed rewrite

**Goal:** Ship a `pg_hba.conf` layout that has zero `trust` predicates for any user (Sentinel B1), uses peer-auth for the local OS user only, and SCRAM for everything else.

**Deliverables:**
1. New `src/auth/pg-hba-template.js`: emits the locked layout — `local autopg_admin <os-user> peer`, `host all all 127.0.0.1/32 scram-sha-256`, `host all all ::1/128 scram-sha-256`, `local all all scram-sha-256` (catch-all). NO `local … all trust` line for any user predicate.
2. Migration: detect existing `~/.pgserve/pg_hba.conf` with legacy `trust` lines, replace with B1-fixed template, restart postmaster.
3. CI smoke: parse the emitted `pg_hba.conf`, assert zero lines matching `/\btrust\b/` regex.

**Acceptance Criteria:**
- [ ] `grep -E '\btrust\b' ~/.autopg/pg_hba.conf` returns 0 hits on every test host.
- [ ] Local OS user can `psql -h /tmp -U autopg_admin -d postgres` without password (peer auth).
- [ ] Network connection from same host on 127.0.0.1 requires SCRAM.
- [ ] Hosts upgraded from pgserve@2.2.x retain their data after the `pg_hba` rewrite + restart.

**Validation:**
```bash
bun test test/auth/pg-hba.test.js && grep -E '\btrust\b' ~/.autopg/pg_hba.conf || echo "B1 ok"
```

**depends-on:** Group 1

---

### Group 3: Schema rename + autopg_apps DDL

**Goal:** Idempotent schema migration from `pgserve_meta` to `autopg_meta`, plus the new `autopg_apps` table that backs `create-app`/`list`/`revoke`/`rotate` lookups.

**Deliverables:**
1. Migration `src/upgrade/steps/100-rename-meta.js`: `ALTER SCHEMA pgserve_meta RENAME TO autopg_meta` if exists; idempotent; logs to upgrade-runner.
2. Migration `src/upgrade/steps/101-autopg-apps-ddl.js`: `CREATE TABLE IF NOT EXISTS autopg_meta.autopg_apps (app text PRIMARY KEY, role text NOT NULL, db text NOT NULL, manifest_sha256 text NOT NULL, manifest_sig_verified boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`.
3. Migration `src/upgrade/steps/102-pgserve-symlink-compat.js`: create `~/.pgserve` symlink → `~/.autopg` for one-milestone backward-compat; print stderr deprecation on detect.
4. Both migrations registered in the existing `src/upgrade/runner.js` (extends, not replaces, the 2.2.0 pattern).

**Acceptance Criteria:**
- [ ] On a fresh host, `autopg_meta` schema exists; `autopg_apps` table exists with the locked columns; no `pgserve_meta` schema present.
- [ ] On a pgserve@2.2.x host, after `autopg install`, all rows from `pgserve_meta.*` are accessible via `autopg_meta.*`; no row count delta per table.
- [ ] Re-running the migration is a no-op (idempotent on the rename and on the DDL).
- [ ] `~/.pgserve` symlink exists and resolves to `~/.autopg` after upgrade.

**Validation:**
```bash
bun test test/upgrade/100-rename-meta.test.js test/upgrade/101-autopg-apps-ddl.test.js test/upgrade/102-pgserve-symlink-compat.test.js
```

**depends-on:** Group 2

---

### Group 4: Delete 7 proxy modules (~2,706 LOC)

**Goal:** Remove the wrapper-proxy code that introduced issue #54's leak class so the leak ceases to exist as a code path. No replacement: native postgres primitives + per-app SCRAM + env-file delivery is the new contract.

**Deliverables:**
1. Delete `src/pg-wire.js` (869 lines), `src/protocol.js` (389), `src/daemon-control.js` (468), `src/router.js` (546), `src/daemon-tcp.js` (297), `src/sdk.js` (137).
2. Delete the ~150-line proxy section in `src/daemon.js` (specific block to be marked in PR; everything else in `daemon.js` stays).
3. Sweep imports: `grep -rn "require.*\\(pg-wire\\|protocol\\|daemon-control\\|router\\|daemon-tcp\\|sdk\\)"` in `src/` returns 0 results post-delete.
4. Run full test suite; expect 0 failures attributable to the deletes (any test that referenced the proxy modules dies with the delete).

**Acceptance Criteria:**
- [ ] `git diff --stat` shows ≥2,700 lines removed in `src/`.
- [ ] `grep -rn` for any deleted module name in `src/` returns 0 hits.
- [ ] `bun test` passes; no test reaches `Cannot find module` for a deleted file.
- [ ] Issue #54 reproduction (60+ conn/s, 30 min) shows zero leaked backends per `pg_stat_activity` audit.

**Validation:**
```bash
bun test && bash test/integration/issue-54-leak-repro.sh
```

**depends-on:** Group 3

---

### Group 5: autopg create-app / list / revoke / rotate + manifest schema + LOCK 1 cosign verify + --adopt-existing-db

**Goal:** Ship the per-app provisioning surface — CLI verbs, the `autopg.json` manifest schema (light-touch v1), LOCK 1 cosign verification before any role/DB is created, and the `--adopt-existing-db` escape hatch for Felipe-host data preservation.

**Deliverables:**
1. CLI verbs in `src/cli/autopg.js`:
   - `autopg create-app <name> --manifest <path> [--adopt-existing-db <db>] [--unsafe-unverified <INCIDENT_ID>]`
   - `autopg list` — reads `autopg_meta.autopg_apps`, prints `app/role/db/manifest_sig_verified`.
   - `autopg revoke <app>` — drops role, drops/keeps DB by flag, removes `~/.autopg/<app>.env`.
   - `autopg rotate <app>` — generates new SCRAM password, updates role, rewrites env file atomically.
2. Manifest schema `schemas/autopg.json.v1.json`:
   ```json
   { "app": "string", "needs": { "database": "string", "extensions": ["string"], "privileges": ["string"], "quotas": { "max_connections": "int" } } }
   ```
   No `publisher_sig` field in v1 — sig comes from the detached `autopg.json.sig` per cosign convention.
3. LOCK 1 verifier in `src/auth/manifest-verify.js`: cosign-verifies `autopg.json.sig` against `cosign.pub` from the publisher key set; rejects unsigned manifests with the locked error string from S9; `--unsafe-unverified <INCIDENT_ID>` bypass writes an audit row tagging the incident id.
4. `--adopt-existing-db <name>` flag: skips `CREATE DATABASE`, validates the named DB exists, grants the per-app role privileges on the existing DB without altering owner.
5. Env-file writer: atomic-rename pattern (`write tmp → fsync → rename → fsync(parent)`), `mode 0o600`, `chown` to OS user.

**Acceptance Criteria:**
- [ ] `autopg create-app omni --manifest packages/api/autopg.json` provisions role `omni`, DB `omni`, writes `~/.autopg/omni.env` with valid `DATABASE_URL`.
- [ ] `autopg create-app omni --manifest packages/api/autopg.json` invoked twice is idempotent (no error, no rotation).
- [ ] Unsigned manifest rejected with the exact S9 error text; `--unsafe-unverified TICKET-123` bypasses with audit row tagged `TICKET-123`.
- [ ] `autopg create-app genie --adopt-existing-db genie` connects to canonical `genie` DB and exposes 2869 migrated tasks (S10).
- [ ] `autopg revoke omni` removes role + DB + env file; `autopg list` no longer shows it.
- [ ] `autopg rotate omni` rewrites env file atomically; concurrent reader never sees a half-written file.

**Validation:**
```bash
bun test test/cli/create-app.test.js test/cli/list.test.js test/cli/revoke.test.js test/cli/rotate.test.js test/auth/manifest-verify.test.js
```

**depends-on:** Group 4

---

### Group 6: Audit + redaction lint

**Goal:** Every privilege-changing operation writes a structured audit row; every audit emitter is lint-checked to redact secrets so a leaked audit log never exposes a password or `DATABASE_URL`.

**Deliverables:**
1. New `src/audit/audit.js`: `auditEmit({op, app, role, actor, manifestSha256, sigVerified, incidentId?})` → JSON line to `~/.autopg/logs/audit.log`. Schema versioned at `schemaVersion: 1`.
2. Redaction lint `scripts/audit-redaction-lint.js`: AST-walk every `auditEmit` call site; assert no field name matches `/password|secret|token|connection_string|database_url/i` and no value comes from `process.env.*PASSWORD*` or matching patterns.
3. Wired CI step `bun run lint:audit`.

**Acceptance Criteria:**
- [ ] Every `create-app` / `revoke` / `rotate` / manifest-verify call produces exactly one audit row.
- [ ] `bun run lint:audit` passes on a clean tree.
- [ ] Synthetic test: an `auditEmit({ password: 'x' })` call breaks the lint with a clear file:line error.
- [ ] `~/.autopg/logs/audit.log` has `mode 0600` (matches admin.secret).

**Validation:**
```bash
bun test test/audit/audit.test.js && bun run lint:audit
```

**depends-on:** Group 4

---

### Group 7: bun build --compile static binaries (5 platforms) + postgres bins bundle

**Goal:** Produce per-platform tarballs that bundle the autopg cli + the matching postgres binaries so a single download installs both.

**Deliverables:**
1. `scripts/build-binary.sh`: runs `bun build --compile --target=<platform> src/cli/autopg.js --outfile dist/<platform>/autopg`.
2. Postgres bin matrix: `scripts/fetch-postgres-bins.sh` downloads the official postgres 16.x binaries for the 5 platforms, places them in `dist/<platform>/postgres/bin/`.
3. Tarball assembly `scripts/assemble-tarball.sh`: produces `dist/autopg-<version>-<platform>.tar.gz` with shape `autopg/{autopg, postgres/bin/*, postgres/share/*, manifest.json}`. `manifest.json` lists per-file SHA256s.
4. Fallback path per `distribution-exodus` G1: if `bun build --compile` fails for a target, retry with `pkg`/`nexe`. Document the fallback in build log.
5. CI matrix: 5 jobs (linux-x64-glibc, linux-x64-musl, linux-arm64, darwin-x64, darwin-arm64).

**Acceptance Criteria:**
- [ ] All 5 tarballs exist in `dist/` with size 50–80MB each.
- [ ] Tarball SHA256 matches the entry in its bundled `manifest.json`.
- [ ] On each platform, extracting the tarball and running `./autopg/autopg --version` prints `autopg 2.260503.1`.
- [ ] On each platform, `./autopg/postgres/bin/postgres --version` prints postgres 16.x.
- [ ] CI matrix is green across all 5 platforms.

**Validation:**
```bash
bash scripts/build-binary.sh --all && bash test/integration/tarball-smoke.sh
```

**depends-on:** Group 5

---

### Group 8: cosign keyless OIDC sign + SLSA L3 attest per-platform tarball

**Goal:** Every published tarball carries a cosign signature and a SLSA L3 provenance attestation so consumers can verify the artifact came from the canonical CI pipeline, not a sideloaded host.

**Deliverables:**
1. CI step `cosign sign-blob --yes dist/autopg-<version>-<platform>.tar.gz --output-signature dist/autopg-<version>-<platform>.tar.gz.sig`.
2. CI step `slsa-verifier`-compatible provenance generation per platform via `actions/attest-build-provenance@v1` (or equivalent).
3. Aggregated `manifest.json` published alongside tarballs lists each tarball's URL, SHA256, signature URL, provenance URL, platform tuple.
4. Public verification key checked into repo at `keys/cosign.pub` and published to `cdn.automagik.dev/autopg/keys/cosign.pub`.

**Acceptance Criteria:**
- [ ] `cosign verify-blob --key keys/cosign.pub --signature <sig> <tarball>` succeeds for every platform tarball.
- [ ] `slsa-verifier verify-artifact <tarball> --provenance-path <prov> --source-uri github.com/automagik-dev/autopg` succeeds for every platform tarball.
- [ ] Tampered tarball fails both verifications with non-zero exit.
- [ ] CI fails if any tarball ships without sig + provenance.

**Validation:**
```bash
bash scripts/verify-published-artifacts.sh dist/
```

**depends-on:** Group 7

---

### Group 9: CDN publish (cdn.automagik.dev/autopg/<channel>/<version>/<platform>/)

**Goal:** Push signed tarballs + manifest + provenance + cosign key to the channel-keyed CDN layout consumed by `install.sh`.

**Deliverables:**
1. CI publish step (depends on `distribution-exodus` G2 CDN infra) that uploads to `cdn.automagik.dev/autopg/<channel>/<version>/<platform>/`. Channels: `stable`, `beta`, `canary`.
2. Channel pointer `cdn.automagik.dev/autopg/<channel>/latest.json` updated atomically (S3 versioned write or equivalent) to point at the just-published version.
3. Public `cdn.automagik.dev/autopg/keys/cosign.pub` updated when key rolls (out-of-band approval; not auto-rolled here).
4. Cache-control headers per `distribution-exodus` D7 (immutable for versioned paths, short TTL for `latest.json`).

**Acceptance Criteria:**
- [ ] After CI green on a release tag, `curl https://cdn.automagik.dev/autopg/stable/latest.json` returns the new version within 60s.
- [ ] All 5 platform tarballs are reachable via `curl -fsSL` at the documented URL pattern.
- [ ] Versioned URLs are immutable (re-publish at same version is a CI failure, not silent overwrite).
- [ ] `latest.json` ETag changes only when the underlying version changes.

**Validation:**
```bash
bash test/integration/cdn-publish.sh --channel stable --version 2.260503.1
```

**depends-on:** Group 8

---

### Group 10: install.sh ≤80 lines (bootstrap + verify + handoff)

**Goal:** Replace the current install.sh with a lean bootstrap that ensures prereqs, downloads + verifies the platform tarball, extracts it, and hands off to `autopg install`. No daemon-management logic in bash.

**Deliverables:**
1. New `install.sh` (≤80 lines, shellcheck-clean):
   - `ensure_bun` — install bun if absent (curl pinned to bun.sh installer).
   - `ensure_pm2` — `bun add -g pm2` if absent.
   - `ensure_curl` — curl OR wget fallback.
   - Detect platform (`uname -s` + `uname -m` + libc detection).
   - `curl` `cdn.automagik.dev/autopg/<channel>/latest.json` → resolve version + tarball URL + sig URL + provenance URL.
   - SHA256 verify, cosign verify, slsa-verifier verify.
   - Extract tarball to `~/.autopg/install/<version>/`.
   - `exec ~/.autopg/install/<version>/autopg/autopg install --non-interactive`.
2. Reject Windows native: print *"Windows native is not supported. Use WSL: see https://docs.automagik.dev/autopg/wsl"* and exit 1.
3. Tested on a clean Linux x64 + Linux arm64 + macOS arm64 container.

**Acceptance Criteria:**
- [ ] `wc -l install.sh` ≤ 80.
- [ ] `shellcheck install.sh` reports 0 warnings.
- [ ] On a clean container, `curl -fsSL https://get.automagik.dev/autopg | bash` produces a working daemon in <60s (S3).
- [ ] Tampered tarball aborts install with the exact cosign verification error.
- [ ] `bash install.sh` on Windows native (no WSL) prints the locked rejection string and exits 1.

**Validation:**
```bash
shellcheck install.sh && wc -l install.sh && bash test/integration/install-sh-fresh-host.sh
```

**depends-on:** Group 9

---

### Group 11: autopg install (binary subcommand)

**Goal:** Pick up where `install.sh` hands off — register the daemon under pm2, install the symlink + completions, edit rc-files for PATH.

**Deliverables:**
1. `src/cli/install.js` implementing `autopg install [--non-interactive]`:
   - pm2 register with `name: autopg`, `script: <install-dir>/autopg`, `args: 'serve'`, `cwd: ~/.autopg`, `autorestart: true`.
   - Symlink `~/.local/bin/autopg` → `<install-dir>/autopg`.
   - Append `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` AND `~/.zshrc` if not already present (idempotent grep-then-append).
   - Install bash + zsh completions to `~/.local/share/autopg/completions/`.
   - Write canonical `~/.autopg/config.json` if absent (channel: `stable`, default port, etc.).
   - First-run hooks: invoke admin SCRAM bootstrap (Group 1) + run upgrade migrations (Group 3) — defensive double-fire per D12.
2. `--non-interactive` mode: never prompts, picks safe defaults, exits 0 only on full success.

**Acceptance Criteria:**
- [ ] After `autopg install --non-interactive`, `autopg --version` works in a new shell (PATH wired).
- [ ] `pm2 list` shows `autopg` process with `online` status.
- [ ] Re-running `autopg install --non-interactive` is idempotent — no duplicate pm2 entry, no duplicated PATH lines.
- [ ] `bash --rcfile ~/.bashrc -c 'autopg --version'` succeeds in CI fixture.
- [ ] First run after install creates `~/.autopg/admin.secret` (Group 1 wired).

**Validation:**
```bash
bun test test/cli/install.test.js && bash test/integration/install-binary.sh
```

**depends-on:** Group 10

---

### Group 12: autopg update — 13-stage pipeline + cleanup-registry + back-compat alias

**Goal:** Implement the `autopg update` command per SHARED-DESIGN.md §4.2 — 13 stages, the same `VerifyResult` tagged-union as the genie/omni siblings, the cleanup-registry pattern with autopg-specific entries, and the `pgserve update` alias for one milestone.

**Deliverables:**
1. `src/cli/update.js` implementing the 13 stages:
   1. `resolveChannel` — read `~/.autopg/config.json`, env override, flag override.
   2. `checkLatestVersion` — fetch `cdn.automagik.dev/autopg/<channel>/latest.json`.
   3. `shortCircuitIfCurrent` — exit 0 with the documented "Already up to date" line.
   4. `confirmIfTTY` — prompt `Update from vX → vY? [Y/n]` unless `--yes` / `GENIE_AUTOPG_UPDATE_YES`.
   5. `detectInstallers` — primary (binary tarball), secondary (none for autopg).
   6. `installPrimary` — download new tarball, verify (sig + SLSA), extract to `~/.autopg/install/<new-version>/`.
   7. `installSecondary` — no-op for autopg; logged as `skipped: not-applicable`.
   8. `syncArtifacts` — flip `~/.local/bin/autopg` symlink to new install dir.
   9. `restartServicesIfRunning` — `pm2 restart autopg` (skipped under `--no-restart`).
   10. `verifyOrFail` — call `runDoctor({ json: true, dryRun: true })`, feed into pure `decideVerify` returning the shared tagged union.
   11. `postUpdateMaintenance` — call `cleanupLegacyArtifacts(skipList)` registry.
   12. `captureDiagnostics` — write `~/.autopg/logs/update-diagnostics-<iso>.json` with `schemaVersion: 1`.
   13. `successBanner` — 3-line ora/chalk output (CLI / Server / Auth).
2. Cleanup-registry entries (`src/cli/legacy-cleanup.js`):
   - `legacy-pgserve-data`: `~/.pgserve/data/*` if `~/.autopg/data/` is canonical and the symlink-compat window has expired.
   - `stale-postmaster-ports`: detect listening sockets owned by orphan postmasters (no matching `postmaster.pid`).
   - `orphan-postmaster-pid`: `~/.autopg/data/postmaster.pid` whose pid is not a live process.
   - `legacy-pgserve-config`: `~/.pgserve/` config dir after symlink-compat window.
3. Back-compat: `pgserve update` alias prints exact stderr deprecation: *"`pgserve update` is deprecated. Run `autopg update` instead. This alias works for one milestone."* and proceeds normally (S13).
4. Diagnostics JSON v1 includes `verify: VerifyResult`, `cleanups: CleanupReport`, `installer: 'binary-tarball'`, `from`, `to`, `channel`.

**Acceptance Criteria:**
- [ ] `autopg update` 13 stages match SHARED-DESIGN.md §4.2 byte-for-byte: same flag names, same exit codes, same tagged-union variants (S11).
- [ ] `autopg update` on current version exits 0 in <2s with the "Already up to date" line.
- [ ] `autopg update --no-restart` skips stages 9 + 10, returns `VerifyResult { kind: 'skipped', reason: 'no-restart' }`, exits 0.
- [ ] All 4 cleanup-registry entries have unit tests for `detect()` true and false paths.
- [ ] `pgserve update` alias prints the locked stderr deprecation and proceeds (S13).
- [ ] Diagnostics JSON `schemaVersion: 1` is valid against `schemas/update-diagnostics.v1.json`.

**Validation:**
```bash
bun test test/cli/update.test.js test/cli/legacy-cleanup.test.js test/cli/pgserve-alias.test.js
```

**depends-on:** Group 11

---

### Group 13: Genie consumer migration

**Goal:** Switch genie to consume autopg via `~/.autopg/genie.env` + ship a signed `autopg.json` at the repo root.

**Deliverables:**
1. New `autopg.json` at repo root (in genie repo, opened as separate PR per the cross-wish blocks below) declaring `app: genie`, `needs.database: genie`, `extensions: ['pgcrypto', 'uuid-ossp']` (or actuals).
2. `_buildConnection` in genie reads `DATABASE_URL` from `~/.autopg/genie.env` if present; falls back to legacy `~/.pgserve/...` path with stderr deprecation for one milestone.
3. genie release pipeline cosign-signs the published `autopg.json` (LOCK 1 source-of-trust) per Group 5.
4. genie host-migration step: detect a host with empty canonical `genie` DB but non-empty embedded pgserve `genie` DB, surface a one-time prompt to run `autopg create-app genie --adopt-existing-db genie` (Felipe-host pattern).

**Acceptance Criteria:**
- [ ] Fresh genie install reads `DATABASE_URL` from `~/.autopg/genie.env`, connects via SCRAM with the per-app role.
- [ ] Pre-existing genie install on pgserve@2.2.x continues working with stderr deprecation for one milestone.
- [ ] genie CLI no longer auto-spawns embedded PG when `~/.autopg/genie.env` exists (kills the bug noted in handoff §7).
- [ ] genie release pipeline uploads `autopg.json` AND `autopg.json.sig` together; missing sig fails CI.

**Validation:**
```bash
# In genie repo (cross-repo PR coordination):
bun test src/db/__tests__/build-connection.test.ts && bash test/integration/genie-autopg-handoff.sh
```

**depends-on:** Group 5, Group 12

---

### Group 14: Omni consumer migration + release pipelines (genie + omni)

**Goal:** Switch omni to consume autopg with signed manifest + chained legacy-data-migration pattern. Add cosign-signing to BOTH genie and omni release pipelines (LOCK 1 source-of-trust per D14).

**Deliverables:**
1. New `packages/api/autopg.json` (in omni repo) declaring `app: omni`, `needs.database: omni`, extensions, quotas (`max_connections`).
2. `_buildConnection` in omni reads `DATABASE_URL` from `~/.autopg/omni.env`; same one-milestone fallback pattern as genie.
3. Chain the existing `legacy-data-migration.ts` pattern when post-rename canonical detected empty: `SET session_replication_role = replica` + per-table COPY + schema-drift abort.
4. genie release pipeline: `cosign sign-blob` the genie `autopg.json` in CI, publish `autopg.json.sig` next to it.
5. omni release pipeline: same as #4 for omni `autopg.json`.
6. CI lint in BOTH repos: published artifact set MUST include `autopg.json` AND `autopg.json.sig`; missing sig blocks release.

**Acceptance Criteria:**
- [ ] Fresh omni install reads `DATABASE_URL` from `~/.autopg/omni.env` and connects via SCRAM.
- [ ] On a host with non-empty embedded omni DB and empty canonical omni DB, the migration runs once, copies data table-by-table, aborts on schema drift, marks `migration_complete` audit row.
- [ ] Both `genie/autopg.json.sig` and `omni/autopg.json.sig` verify against the publisher cosign key.
- [ ] CI fails on either repo if `autopg.json` ships without a matching sig.

**Validation:**
```bash
# In omni repo:
bun test packages/api/src/db/__tests__/build-connection.test.ts \
  packages/api/src/db/__tests__/legacy-data-migration.test.ts \
  && bash test/integration/omni-autopg-handoff.sh
# In CI (release tag):
bash scripts/verify-published-manifest-sig.sh
```

**depends-on:** Group 5, Group 12, Group 13

---

### Group 15: Final pgserve@2.260503.0 npm advisory

**Goal:** Cut a final npm release whose package body is one line that exits 2 with the curl install hint, deprecating the npm distribution channel for good (D10 soft cut).

**Deliverables:**
1. New `pgserve` npm package version `2.260503.0` with `bin/pgserve.js`:
   ```js
   #!/usr/bin/env node
   console.error("npm publishing discontinued — install via curl https://get.automagik.dev/autopg | bash");
   process.exit(2);
   ```
2. Updated `package.json` removing all runtime deps; `bin` field points at the one-liner.
3. README on npm page: short paragraph + curl install command + link to migration guide.
4. CI publish step gated on a release tag matching `pgserve-final-v*`.
5. Verify the package shows on npmjs.com with the deprecation notice within 5 min of publish.

**Acceptance Criteria:**
- [ ] `npm install -g pgserve@2.260503.0 && pgserve` exits 2 with the locked stderr text (S2).
- [ ] `pgserve@2.260503.0` is the latest npm version after publish (no `dist-tags` regression).
- [ ] No version above `2.260503.0` is ever published to npm under the `pgserve` name.
- [ ] README on npmjs.com shows the migration paragraph.

**Validation:**
```bash
npm install -g pgserve@2.260503.0 && pgserve; test $? -eq 2 || echo "FAIL: expected exit 2"
```

**depends-on:** Group 12

---

### Group 16: Documentation + migration guide unified across genie/omni/autopg

**Goal:** A single migration guide that covers all three consumers, lives at `docs.automagik.dev/autopg/migration/`, and explains: what changed, why, the upgrade path for pgserve@2.2.x hosts, the `--adopt-existing-db` Felipe-host pattern, and the one-milestone back-compat window.

**Deliverables:**
1. `docs/migration/from-pgserve-2.2-to-autopg-2.260503.md` — top-of-funnel doc, 5–10 minute read.
2. Per-consumer sections for genie + omni, plus a generic "your app" section template.
3. Trust-boundary explainer: short chapter on D3 + the deferred LOCK 2 pairing infrastructure (link to council-1777663000 summary).
4. CHANGELOG entry across all three repos with the exact trust-boundary text from D3 (S14).
5. `docs.automagik.dev` build pipeline picks up the new doc directory.

**Acceptance Criteria:**
- [ ] `docs.automagik.dev/autopg/migration/` is reachable post-deploy.
- [ ] CHANGELOG in `pgserve`, `genie`, `omni` all contain the exact D3 text; CI lint blocks release if absent (S14).
- [ ] Migration guide passes a doc-lint pass: no broken links, every command block tested in a sandbox.
- [ ] A first-time reader (proxied by a /docs review pass) reaches "I know what to do" in <10 min.

**Validation:**
```bash
bash scripts/changelog-trust-boundary-lint.sh && bun run docs:test
```

**depends-on:** Group 14

---

### Group 17: SHARED-DESIGN.md byte-equality CI lint

**Goal:** Wire a CI lint that fails the build if SHARED-DESIGN.md drifts between the three sibling repos (pgserve, genie, omni). Single source of truth or it isn't.

**Deliverables:**
1. `scripts/shared-design-byte-equality.sh`: fetches the SHARED-DESIGN.md from each sibling repo (pinned to the corresponding wish branch / merged commit), `diff`s them; non-zero diff = exit 1 with file:line drift report.
2. CI step in all 3 repos invoking the script. The script shells out to `gh` for cross-repo fetch.
3. Coordinated update path: a SHARED-DESIGN.md edit requires a single PR across all 3 repos with the same hash. PR-template checkbox: *"I updated SHARED-DESIGN.md → I opened the matching PR in the other 2 repos with the same commit body."*

**Acceptance Criteria:**
- [ ] Drift introduced in any of the 3 repos fails CI within minutes (S12).
- [ ] Coordinated update across all 3 repos passes CI in all 3.
- [ ] Script handles auth (read-only `gh` token in CI) without requiring secrets beyond the standard `GITHUB_TOKEN`.
- [ ] False-positive resistant: ignores trailing whitespace, line-ending differences are normalized to LF.

**Validation:**
```bash
bash scripts/shared-design-byte-equality.sh --dry-run
```

**depends-on:** Group 16

---

### Group 18: Cutover validation — Felipe-host + doctor 11/11 + sentinel signoff

**Goal:** Final gate before tagging `autopg 2.260503.1`. Felipe's host runs the entire cutover path end-to-end with data preservation; `autopg doctor` reports 11/11 green; council sentinel signs off on threat model.

**Deliverables:**
1. End-to-end cutover script `scripts/cutover-validation.sh`: from a `pgserve@2.2.1` host, install autopg, run upgrade migrations, run `autopg create-app genie --adopt-existing-db genie` and `autopg create-app omni --adopt-existing-db omni`, verify task counts pre/post, run issue #54 leak repro.
2. `autopg doctor` 11-check matrix: admin SCRAM live, `pg_hba` B1-clean, `autopg_meta` schema present, `autopg_apps` table present, per-app role count matches env-file count, no `postgres:postgres` plaintext on disk, cosign key reachable, latest CDN version visible, pm2 process online, audit log writable, redaction lint passes.
3. Council sentinel signoff: convene `council-final-cutover` to review threat model post-implementation; record verdict in `brain/_decisions/autopg-cutover-sentinel-signoff.md` (S16).
4. Release tag + CDN promotion only fires after S1–S16 all check.

**Acceptance Criteria:**
- [ ] `bash scripts/cutover-validation.sh` on Felipe-host returns 0 with 2869 tasks + 18 boards + 716 wishes preserved (S10, S15).
- [ ] `autopg doctor` reports 11/11 green.
- [ ] Council sentinel signs off in writing; signoff doc references the threat-model commit hash.
- [ ] All 16 success criteria (S1–S16) checked off in this WISH.md before tag is cut.

**Validation:**
```bash
bash scripts/cutover-validation.sh --host felipe && autopg doctor --json | jq '.summary'
```

**depends-on:** Group 17

---

## Cross-wish dependencies

```yaml
depends-on:
  - genie/genie-supply-chain-signing  # cosign + SLSA infra MUST ship first
  - genie/distribution-exodus          # CDN infra MUST ship first; autopg becomes second consumer
  - genie/update-unify-stages          # sibling — ships in parallel; pipeline contract
  - omni/update-unify-stages           # sibling — ships in parallel; pipeline contract

blocks:
  - genie/autopg-consumer-migration    # implied by Group 13
  - omni/autopg-consumer-migration     # implied by Group 14
```

## QA Criteria

_What must be verified on `dev` after merge. The QA agent tests each criterion._

- [ ] Functional — `curl -fsSL https://get.automagik.dev/autopg | bash` on a clean Linux container produces a working daemon in <60s with admin SCRAM bootstrapped (S3).
- [ ] Functional — `autopg create-app omni && autopg create-app genie` provisions both consumers with per-app role + DB + env-file (S4).
- [ ] Functional — `autopg update` 13-stage pipeline matches SHARED-DESIGN.md byte-for-byte (S11).
- [ ] Functional — `pgserve update` alias prints the deprecation and proceeds (S13).
- [ ] Functional — `autopg create-app genie --adopt-existing-db genie` on Felipe-host shows 2869 tasks visible (S10).
- [ ] Integration — Issue #54 sustained 60+ conn/s for 30 min shows zero leaked backends (S6).
- [ ] Integration — Existing pgserve@2.2.1 host upgrades to autopg without losing per-app DBs (S15).
- [ ] Integration — Both `genie/autopg.json` and `omni/autopg.json` cosign-verify against the publisher key.
- [ ] Security — Zero `postgres:postgres` plaintext anywhere on host post-install (S5).
- [ ] Security — `pg_hba.conf` has zero `trust` predicates (Sentinel B1).
- [ ] Security — Tampered tarball aborts install with cosign verification error.
- [ ] Security — Unsigned `autopg.json` rejected with the locked S9 error string; `--unsafe-unverified` bypass writes audit row.
- [ ] Regression — pgserve@2.2.x upgrade path preserves all per-fingerprint table counts before/after.
- [ ] Regression — `autopg doctor` reports 11/11 on Felipe-host post-cutover.
- [ ] Compliance — CHANGELOG contains exact trust-boundary text (S14).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `genie-supply-chain-signing` slips → no cosign infra → Group 8 blocked | High | Cross-wish dependency declared upfront. If supply-chain-signing is not ready when Wave 3 opens, escalate to Felipe before starting Group 8. |
| `distribution-exodus` slips → no CDN → Group 9 blocked | High | Same as above. CDN URL pattern is a published contract; if exodus changes the pattern, Group 9/10 must follow. |
| Sibling `update-unify-stages` (genie/omni) drift on SHARED-DESIGN.md before Group 17 lint exists | Medium | Group 17 must land before any parallel SHARED-DESIGN.md edit. If a sibling lands an edit first, replay it byte-identical here as the lint gate. |
| `bun build --compile` fails for one of 5 platforms | Medium | Group 7 includes `pkg`/`nexe` fallback per `distribution-exodus` G1. Document which platforms fall back in build log. |
| Felipe-host `--adopt-existing-db` adoption corrupts canonical genie DB during validation | High | Group 18 cutover-validation.sh runs on a snapshot first; only commits to the live DB after a `pg_dump` baseline + verified table-count match. Backout = `pg_restore` from baseline. |
| LOCK 1 cosign-verify fails for a legitimate manifest because of clock skew or key rotation | Medium | Group 5 includes `--unsafe-unverified <INCIDENT_ID>` bypass with audit-row tagging. Operators have an escape hatch; the audit row gates post-mortem. |
| `pgserve update` alias breaks for a consumer that scrapes stderr | Low | The alias still proceeds (D13); it only adds a stderr line. Consumers parsing stderr are out-of-contract per agent-bible §1. |
| Host with non-default postgres on a conflicting port collides during install | Medium | Group 11 first-run probes for port conflicts and either picks an alternate port (config-recorded) or aborts with a documented error. |
| Cutover skipped on a host that ran `autopg install` before Group 12 shipped | Low | Group 12 includes the `pgserve update` alias; first run of `autopg update` sweeps the upgrade migrations. Defensive double-fire per D12. |
| Council sentinel withholds signoff on Group 18 → release blocked indefinitely | Medium | Council convened with explicit signoff criteria from D3 + S16 upfront. If signoff blocked, escalate to Felipe with sentinel's specific objections; do not ship past a withheld signoff. |

---

## Review Results

_Populated by `/review` after planning gate; updated by `/review` again after execution._

---

## Files to Create/Modify

```
# Modify
src/postgres.js                                         # wire admin-bootstrap + upgrade-runner
src/daemon.js                                           # delete proxy section (~150 LOC)
src/upgrade/runner.js                                   # extend with steps 100–104
package.json                                            # rename, version 2.260503.1, remove deps
README.md                                               # rewrite as autopg
CHANGELOG.md                                            # add D3 trust-boundary text
install.sh                                              # rewrite ≤80 lines
.github/workflows/release.yml                           # bun build + cosign + SLSA + CDN publish

# Create
src/auth/admin-bootstrap.js                             # Group 1
src/auth/pg-hba-template.js                             # Group 2
src/upgrade/steps/100-rename-meta.js                    # Group 3
src/upgrade/steps/101-autopg-apps-ddl.js                # Group 3
src/upgrade/steps/102-pgserve-symlink-compat.js         # Group 3
src/cli/autopg.js                                       # Group 5 (entry point)
src/cli/create-app.js                                   # Group 5
src/cli/list.js                                         # Group 5
src/cli/revoke.js                                       # Group 5
src/cli/rotate.js                                       # Group 5
src/cli/install.js                                      # Group 11
src/cli/update.js                                       # Group 12
src/cli/legacy-cleanup.js                               # Group 12
src/auth/manifest-verify.js                             # Group 5
src/audit/audit.js                                      # Group 6
schemas/autopg.json.v1.json                             # Group 5
schemas/update-diagnostics.v1.json                      # Group 12
keys/cosign.pub                                         # Group 8
scripts/build-binary.sh                                 # Group 7
scripts/fetch-postgres-bins.sh                          # Group 7
scripts/assemble-tarball.sh                             # Group 7
scripts/verify-published-artifacts.sh                   # Group 8
scripts/audit-redaction-lint.js                         # Group 6
scripts/changelog-trust-boundary-lint.sh                # Group 16
scripts/shared-design-byte-equality.sh                  # Group 17
scripts/cutover-validation.sh                           # Group 18

# Test
test/auth/admin-bootstrap.test.js                       # Group 1
test/auth/pg-hba.test.js                                # Group 2
test/auth/manifest-verify.test.js                       # Group 5
test/upgrade/100-rename-meta.test.js                    # Group 3
test/upgrade/101-autopg-apps-ddl.test.js                # Group 3
test/upgrade/102-pgserve-symlink-compat.test.js         # Group 3
test/cli/create-app.test.js                             # Group 5
test/cli/list.test.js                                   # Group 5
test/cli/revoke.test.js                                 # Group 5
test/cli/rotate.test.js                                 # Group 5
test/cli/install.test.js                                # Group 11
test/cli/update.test.js                                 # Group 12
test/cli/legacy-cleanup.test.js                         # Group 12
test/cli/pgserve-alias.test.js                          # Group 12
test/audit/audit.test.js                                # Group 6
test/integration/issue-54-leak-repro.sh                 # Group 4
test/integration/tarball-smoke.sh                       # Group 7
test/integration/cdn-publish.sh                         # Group 9
test/integration/install-sh-fresh-host.sh               # Group 10
test/integration/install-binary.sh                      # Group 11
test/integration/genie-autopg-handoff.sh                # Group 13 (cross-repo)
test/integration/omni-autopg-handoff.sh                 # Group 14 (cross-repo)

# Reference (read-only)
.genie/wishes/autopg-distribution-cutover/SHARED-DESIGN.md   # byte-identical with siblings
```
