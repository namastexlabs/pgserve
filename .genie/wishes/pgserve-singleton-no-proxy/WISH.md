# Wish: pgserve singleton — kill proxy, add cosign, new CLI verbs (v2.3)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pgserve-singleton-no-proxy` |
| **Date** | 2026-05-06 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | large (~3-4 weeks) |
| **Branch** | `wish/pgserve-singleton-no-proxy` |
| **Repos touched** | `automagik/pgserve` |
| **Design** | [SHARED-DESIGN.md](./SHARED-DESIGN.md) |

> **Companion wishes** (byte-identical SHARED-DESIGN.md): `automagik-dev/genie#pgserve-singleton-no-proxy`, `automagik/omni#pgserve-singleton-no-proxy`. All three ship in parallel against their respective integration branches.

## Summary

Major bump to pgserve **2.3.0**. Kill the bun bridge from the data plane: postgres backend listens directly on Unix socket (`$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432`) AND TCP 5432, no proxy. Replace the always-on bun daemon with on-demand CLI verbs (`pgserve provision`, `pgserve verify`, `pgserve gc`, `pgserve trust`, `pgserve doctor`). Add cosign-keyless-OIDC publisher attestation as Tier 2 on top of the existing host_signed identity (Tier 1) and path-based default (Tier 0). Bake a hardcoded blocklist of known-bad versions. Wire self-healing semantics into `pgserve update` (auto-migrate old layout, pm2 restart, doctor --fix tiered). See `SHARED-DESIGN.md` §1-§9 for full design context.

> **⚠ BREAKING — accept-downtime contract**: TCP port `8432` dies in this release. Out-of-trio consumers that hardcode `localhost:8432` (brain, rlmx, hapvida-eugenia, email, any third-party app) **WILL break silently** when `pgserve update` runs. This is intentional: pgserve 2.3 is a major bump and the cutover is the right moment to take that hit once. CHANGELOG must warn explicitly. QA Criteria adds a consumer-fan-out test (verify all known consumers connect post-cutover). **No socat shim. No port-redirect. No backwards-compat layer.** Operators update connection strings to Unix socket (preferred) or TCP 5432.

## Scope

### IN

**Group 1 — Postmaster reconfig + dual-transport (data-plane core)**
- Postmaster boot args: `-k $XDG_RUNTIME_DIR/pgserve` + `-p 5432` + `listen_addresses = 'localhost'`. Fallback `/tmp/pgserve` when `$XDG_RUNTIME_DIR` unset (CI runners).
- `pgserve install` ensures `$XDG_RUNTIME_DIR/pgserve` directory exists (mode 0700), wires postgres pm2/systemd/launchd entry pointing at postmaster directly (no bun bridge process).
- Stale-lock detection: refuse install if `pgserve.pid` exists with live PID; archive prior socket dirs to `.legacy/`.
- `pgserve port` returns 5432 (was 8432).

**Group 2 — Delete the bun proxy data plane**
- Remove libpq protocol routing layer (the bun process that listens on 8432 and rewrites startup-message `database=` parameter).
- Remove always-on daemon supervision logic.
- Remove SO_PEERCRED-based startup-message rewriting (peer's app identity now resolved by `pgserve provision` invocation, not at connect time).
- Audit becomes `pgaudit` postgres extension load (replaces the application-level audit-log writer).
- Audit-log file path stays at `~/.pgserve/audit.log` for compat with existing tooling, but writes come from `pgaudit` config not bun.

**Group 3 — New CLI verbs**
- `pgserve provision <fingerprint>`: idempotent. Reads `package.json` (or fallback to `cwd` fingerprint if no package.json), resolves tier (path / host_signed / cosign_signed), creates DB + role with appropriate GRANTs, writes `pgserve_meta` row. Concurrency-safe via `pg_advisory_lock` keyed on fingerprint hash. Accepts `42P04` (database already exists) as success.
- `pgserve verify <binary-path>`: cosign keyless OIDC verification against trust list. On success, writes HMAC-signed cache token at `$XDG_STATE_HOME/pgserve/verified/<fingerprint>.token` (web-session-style). Sliding expiry 1h idle / 7d max. Re-verify on binary mtime change. `--skip-sigstore` flag for offline mode.
- `pgserve gc`: sweeps orphaned databases (uid removed, project-marker mtime stale). Run by cron / systemd timer / launchd job — wired by `pgserve install`. Replaces in-daemon GC sweep loop.
- `pgserve trust add --identity <issuer> --key <pubkey>`, `pgserve trust list`, `pgserve trust remove <id>`: manage user-extensible trust roots. Writes `~/.pgserve/trust/identities.json`.
- `pgserve doctor` / `--fix` / `--fix --aggressive`: tiered modes per `SHARED-DESIGN.md` §3.2.

**Group 4 — Cosign verification primitives**
- Hardcoded trust list compiled into binary: identities for genie, omni, pgserve release workflows.
- Cosign keyless OIDC verifier (vendor sigstore-rs OR shell out to `cosign verify` if PATH).
- HMAC-signed cache token format (token contents + tamper-evident HMAC keyed on `~/.local/state/pgserve/cache.hmac`).
- `pgserve_meta` schema delta: add `verified_at TIMESTAMPTZ`, `verified_identity TEXT`, `verified_tier TEXT CHECK (verified_tier IN ('path', 'host_signed', 'self_signed', 'cosign_signed'))`. Additive migration.
- Existing `host_signed` handshake (genie #1569) coexists; cosign tier sits on top, evaluated first per `identity_chain` ordering.

**Group 5 — Hardcoded blocklist**
- Compile-time `BLOCKED_VERSIONS` constant. Currently empty.
- `pgserve install` and `pgserve update` refuse blocked versions with diagnostic.
- No active revocation infra (no Rekor consultation, no revoked.json sync) per `SHARED-DESIGN.md` §2.5.

**Group 6 — Self-healing `pgserve update`**
- Pre-install version check (already shipped); extend to check `BLOCKED_VERSIONS`.
- New step: detect old proxy layout (pm2 entry running bun on 8432), stop bun process, reconfigure pm2 entry to launch postmaster directly, archive old socket dirs.
- `pm2 restart <self> --update-env` after install.
- `pgserve doctor --fix` invocation post-restart (default tiered mode).
- Confirmation prompt warns about active connections; `--yes` skips.

**Group 7 — Roles + GRANTs schema**
- Standard role template per `SHARED-DESIGN.md` §4.
- Idempotent CREATE ROLE / GRANT logic in `pgserve provision`.
- `pg_hba.conf` template with peer auth on Unix socket; `pg_ident.conf` mapping uid → role.
- `pgserve grant <from-publisher> <to-publisher> <permission>` CLI for explicit cross-DB grants (cosign tier only).

**Group 8 — Migration tooling for existing hosts**
- One-shot migration runs inside `pgserve update` when old layout detected.
- Action: stop bun process, reconfigure pm2 entry, update `~/.autopg/admin.json` to publish new socket dir, archive old socket dirs to `~/.autopg/.legacy/<ts>/`.
- Idempotent: re-running on already-migrated host is no-op.
- **Best-effort recovery, not atomic**: rollback is via `pgserve install --restore-bridge` (manual escape hatch). Snapshot scope: `~/.autopg/admin.json` + pm2 ecosystem dump only (not socket dirs — those archive forward). On mid-flight failure, restore admin.json from snapshot, log diagnostic exit non-zero with operator remediation hint.

**Group 9 — Tests + docs + CHANGELOG**
- Tests for every new CLI verb.
- Migration test from synthetic v2.2.x state to v2.3.x.
- Cosign verify tests.
- CHANGELOG entry naming the contracts.

### OUT

- `pgserve@3.0.0` bump — reserved for post-npm-departure cutover (`distribution-exodus`).
- Sigstore policy plugins, transparency-log consultation, revoked.json sync.
- Embedded TUF roots / offline-by-default verifier.
- `automagik update --all` orchestrator binary.
- Cross-host pgserve federation.
- Drain-before-restart semantics.
- Migrating brain, rlmx, hapvida-eugenia, email consumer apps.
- Aegis runtime sandboxing.
- TLS termination on TCP 5432.

## Decisions

See `SHARED-DESIGN.md` §6 for the cross-repo decision table. pgserve-specific:

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | Postmaster `-k $XDG_RUNTIME_DIR/pgserve -p 5432` (not 8432) | Canonical socket path that genie's `resolvePgserveLibpqSocketPath()` already expects. Port 5432 is the postgres standard. |
| P2 | TCP fallback to `/tmp/pgserve` when XDG_RUNTIME_DIR unset | CI runners and minimal containers lack XDG. |
| P3 | `pgserve gc` as cron / timer (not in-daemon) | Matches `SHARED-DESIGN.md` decision #2: zero always-on processes besides postgres. |
| P4 | `pgserve_meta` schema additive (no breaking column drop) | Existing `path`-kind rows from pre-cosign installs continue to work. |
| P5 | **Shell out to `cosign` CLI as the verifier (locked).** Vendor sigstore-rs deferred to a follow-up wish. | Single verifier path → simpler test matrix; matches CDN distribution model where cosign CLI is already on the install pipeline; if `cosign` not on PATH, `pgserve install` shells out to a downloader to fetch the official static binary into `~/.pgserve/bin/cosign`. Operators wanting fully-bundled verification get it via the sigstore-rs follow-up. |
| P6 | Blocklist as compile-time constant (not config file) | Trust root must be opaque to operators. Updates flow via `pgserve update`. |
| P7 | Migration runs inside `pgserve update` (not separate command) | Self-healing contract: one verb fixes everything. |

## Success Criteria

- [ ] On a fresh host, `pgserve install` creates `$XDG_RUNTIME_DIR/pgserve/` with correct perms, registers postgres in pm2/systemd, and `psql -h $XDG_RUNTIME_DIR/pgserve` connects without `-p`.
- [ ] On a host with old layout: single `pgserve update` reconfigures everything; pm2 list shows 1 entry tracking postgres directly; old bun process gone.
- [ ] No bun-as-data-plane process anywhere post-cutover.
- [ ] `pgserve provision <fingerprint>` is concurrency-safe: 10 simultaneous calls produce exactly 1 DB.
- [ ] `pgserve verify` against legitimate signed binary: passes, writes cache token.
- [ ] `pgserve verify` against tampered binary: rejects with diagnostic.
- [ ] `pgserve verify --skip-sigstore` against operator-pretrusted key: passes offline.
- [ ] `pgserve gc` as cron entry: removes orphaned DBs; leaves active DBs alone.
- [ ] `pgserve doctor --fix` (default): mutates Cat 1 silently; prompts Cat 2; refuses Cat 3.
- [ ] `pgserve doctor --fix --aggressive`: mutates Cat 1+2 without prompt.
- [ ] Hardcoded blocklist: setting test version causes refuse with exit code 4.
- [ ] `pgserve --requirements --json` returns valid JSON manifest.
- [ ] `pg_hba.conf` peer auth on Unix socket maps OS user → fingerprint role correctly.
- [ ] Cross-DB grants: `pgserve grant` works only between cosign-verified publishers.
- [ ] All existing pgserve tests pass byte-identically.
- [ ] CHANGELOG entry naming: socket path canonical-ization, blocklist, tiered doctor, cosign tier.
- [ ] Migration test: synthetic v2.2.x state → run `pgserve update` → assert v2.3.x state.
- [ ] `bun run lint` and `bun run typecheck` clean.

## Execution Strategy

### Wave 1 — Data plane core (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Postmaster reconfig: `-k`, `-p 5432`, dual-transport. `pgserve install` socket dir setup. |
| 2 | engineer | Delete bun proxy data plane. Replace audit with `pgaudit`. |

### Wave 2 — CLI surface + verification (sequential — G3+G4+G7 all author `pgserve provision` and share `pgserve_meta` schema)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Cosign verification primitives + cache token + `pgserve verify` + `pgserve_meta` schema delta (additive). **First in Wave 2** — defines schema columns G3 writes. |
| 3 | engineer | New CLI verbs (`provision`, `gc`, `trust`, `doctor` tiered). Provisioning writes columns G4 added. |
| 7 | engineer | Roles + GRANTs schema, hba/ident templates, `pgserve grant`. Adds role logic on top of provision skeleton from G3. |

### Wave 3 — Self-healing wiring (sequential after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Hardcoded blocklist + refusal in install/update paths. |
| 6 | engineer | Self-healing `pgserve update` pipeline. |
| 8 | engineer | Migration tooling for existing hosts. |

### Wave 4 — Validation

| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | Tests + docs + CHANGELOG. |

## Execution Groups

### Group 1: Postmaster reconfig + dual-transport

**Goal:** Postgres backend listens on canonical Unix socket + TCP 5432 natively. `pgserve install` ensures the socket dir exists with correct perms.

**Deliverables:**
1. `bin/postgres-server.js` updated to pass `-k <socket-dir>` and `-p 5432` to postmaster.
2. Helper `resolveSocketDir(): string` — returns `$XDG_RUNTIME_DIR/pgserve` (preferred) or `/tmp/pgserve` (fallback).
3. `pgserve install` step: `mkdir -p <socket-dir>` (mode 0700), validate writability.
4. `pgserve port` returns `5432`.
5. Update `~/.autopg/admin.json` to publish `socketDir` + `port: 5432`.

**Acceptance Criteria:**
- [ ] `pgserve install` on a fresh host creates `$XDG_RUNTIME_DIR/pgserve/` with mode 0700.
- [ ] After `pgserve install`, `psql -h $XDG_RUNTIME_DIR/pgserve` (no `-p`) connects.
- [ ] After `pgserve install`, `psql -h 127.0.0.1 -p 5432` connects.
- [ ] `pgserve port` outputs `5432`.

**Validation:**
```bash
pgserve install
test -d "$XDG_RUNTIME_DIR/pgserve" && stat -c '%a' "$XDG_RUNTIME_DIR/pgserve" | grep -q 700
psql -h "$XDG_RUNTIME_DIR/pgserve" -c 'SELECT 1' postgres
```

**depends-on:** none

---

### Group 2: Delete bun proxy data plane

**Goal:** Remove the always-on bun process that proxies libpq traffic on TCP 8432. Replace audit with `pgaudit` extension.

**Deliverables:**
1. Delete libpq routing module + startup-message rewriting.
2. Update pm2 entry shape: `pgserve` pm2 entry tracks postgres binary directly via wrapper.
3. Configure `pgaudit` extension via `shared_preload_libraries`.
4. Ship `logrotate.d/pgserve` config.

**Acceptance Criteria:**
- [ ] No bun process listening on TCP 8432 after `pgserve install`.
- [ ] `pg_settings` shows `pgaudit.log = 'all'`.
- [ ] pm2 `pgserve` entry's `pm_exec_path` points to postgres wrapper, not bun.
- [ ] **Positive check**: `psql -h $XDG_RUNTIME_DIR/pgserve -c 'SELECT 1' postgres` returns `1` (postgres is responsive on canonical socket via the new pm2 wrapper).
- [ ] **Positive check**: `psql -h 127.0.0.1 -p 5432 -c 'SELECT 1' postgres` returns `1` (postgres is responsive on canonical TCP).

**Validation:**
```bash
pm2 jlist | jq '.[] | select(.name == "pgserve") | .pm2_env.pm_exec_path'
ss -tlnp | grep -E ':8432' && exit 1 || echo "OK no 8432 listener"
psql -h $XDG_RUNTIME_DIR/pgserve -c 'SELECT 1' postgres
psql -h 127.0.0.1 -p 5432 -c 'SELECT 1' postgres
```

**depends-on:** Group 1

---

### Group 3: New CLI verbs

**Goal:** Replace daemon control plane with on-demand CLI: `provision`, `gc`, `trust`, `doctor`.

**Deliverables:**
1. `pgserve provision <fingerprint>`: reads package.json or fallback cwd fingerprint; resolves tier; `pg_advisory_lock`-deduped; idempotent CREATE ROLE/DATABASE/GRANT; writes `pgserve_meta`.
2. `pgserve gc`: scans `pgserve_meta` for orphans; DROP DATABASE; audit-log every drop.
3. `pgserve trust add/list/remove`: writes `~/.pgserve/trust/identities.json`; refuses to remove hardcoded entries.
4. `pgserve doctor` / `--fix` / `--fix --aggressive`: tiered modes per `SHARED-DESIGN.md` §3.2.

**Acceptance Criteria:**
- [ ] `pgserve provision @automagik/genie/abc123` is idempotent.
- [ ] 10 concurrent `provision` calls produce exactly 1 DB.
- [ ] `pgserve gc` removes a synthetic orphan.
- [ ] `pgserve trust list` shows hardcoded + user entries.
- [ ] `pgserve doctor --fix` mutates Cat 1 silently, prompts Cat 2, refuses Cat 3.

**Validation:**
```bash
bun test tests/cli/
```

**depends-on:** Group 1

---

### Group 4: Cosign verification primitives

**Goal:** Cosign-keyless-OIDC verification with HMAC-signed cache tokens.

**Deliverables:**
1. Hardcoded `TRUSTED_IDENTITIES` constant.
2. `verifyBinary(path)` — shells out to `cosign verify` or vendored verifier. Returns tagged-union.
3. HMAC-signed cache token writer/reader. Auto-generated cache.hmac key.
4. `pgserve_meta` schema migration (additive).
5. `pgserve verify <binary-path>` CLI verb.
6. `--skip-sigstore` flag with pretrusted-key requirement.

**Acceptance Criteria:**
- [ ] `pgserve verify` against legitimate signed binary: passes, cache written.
- [ ] Second invocation: reads cache, no re-verify.
- [ ] Tampered binary: rejects.
- [ ] `--skip-sigstore` without pretrusted key: refuses.
- [ ] `--skip-sigstore` with `pgserve trust add --offline-cosign-key`: passes.

**Validation:**
```bash
bun test tests/cli/verify.test.js tests/cosign/
```

**depends-on:** Group 1

---

### Group 5: Hardcoded blocklist

**Goal:** Compile-time list of known-bad versions. Refuse install/update for blocked.

**Deliverables:**
1. `BLOCKED_VERSIONS` compile-time constant. Initially `[]`.
2. `pgserve install`/`update` checks blocklist; refuses with diagnostic.
3. Test fixture injects blocked version + asserts refusal.

**Acceptance Criteria:**
- [ ] `BLOCKED_VERSIONS` exists and is empty by default.
- [ ] Install with blocked test-version refuses with exit code 4.

**Validation:**
```bash
bun test tests/blocklist.test.js
```

**depends-on:** Group 3

---

### Group 6: Self-healing `pgserve update` pipeline

**Goal:** `pgserve update` from old layout → new layout is one-shot; idempotent.

**Deliverables:**
1. Detection logic for old proxy layout (pm2 entry running bun on 8432).
2. Migration sequence: stop bun, reconfigure pm2 entry, archive old socket dirs.
3. Post-restart `pgserve doctor --fix` (default tiered mode).
4. Active-connection check via `pg_stat_activity`; prompt unless `--yes`.

**Acceptance Criteria:**
- [ ] Synthetic old-layout host: `pgserve update` reconfigures everything; second run is no-op.
- [ ] Active-connection prompt warns operator before kicking restart.
- [ ] Audit-log captures each migration step.

**Validation:**
```bash
bash tests/integration/upgrade-from-2.2.x.sh
```

**depends-on:** Group 5

---

### Group 7: Roles + GRANTs schema

**Goal:** Auto-create role per fingerprint with appropriate GRANTs by tier; `pg_hba.conf` peer auth.

**Deliverables:**
1. `pgserve provision` creates `app_<fp>` role; sets DB owner; grants whitelisted-extension function access.
2. For cosign_signed in hardcoded list: creates `pgserve_app_<sanitize(name)>` role.
3. `pg_hba.conf` template (peer auth on Unix socket via map).
4. `pg_ident.conf` template (uid → role mapping).
5. `pgserve grant <from> <to> <permission>` CLI; cosign-tier only.

**Acceptance Criteria:**
- [ ] Role + DB ownership + GRANTs match `SHARED-DESIGN.md` §4 after provision.
- [ ] Peer auth via Unix socket connects to `app_<fp>` role automatically.
- [ ] `pgserve grant` between cosign-tier publishers succeeds; refuses for path-tier.
- [ ] Path-tier role cannot SELECT from another path-tier role's DB.

**Validation:**
```bash
bun test tests/sql/
```

**depends-on:** Group 1

---

### Group 8: Migration tooling for existing hosts

**Goal:** Operators with old layout get clean cutover by running `pgserve update` once.

**Deliverables:**
1. Detect old layout (pm2 jlist inspection).
2. Atomic migration with rollback: snapshot, stop bun, reconfigure pm2, update admin.json, archive old sockets, start postgres, verify.
3. Failure restores from snapshot, logs diagnostic.
4. `pgserve install --restore-bridge` manual escape hatch.

**Acceptance Criteria:**
- [ ] Synthetic old-layout host: full migration completes in <30s, idempotent.
- [ ] Failure mid-reconfigure: admin.json restored from snapshot.
- [ ] Archive directory contains old socket dirs (forensic preservation).

**Validation:**
```bash
bash tests/integration/migration-from-old-layout.sh
bash tests/integration/migration-rollback-on-failure.sh
```

**depends-on:** Group 6

---

### Group 9: Tests + docs + CHANGELOG

**Goal:** Lock the contracts; document the breaking changes.

**Deliverables:**
1. Full test suite for all CLI verbs + verify + GC + roles + migration.
2. Integration tests: fresh-install, upgrade-from-2.2.x, upgrade-noop.
3. **CI fixture provisioning** (no sudo): tests boot postgres + pm2 in user-space via `bunx pm2-runtime` and `pgserve install --data ./tmp/test-data --port 65432 --skip-system-units`. Documented in `tests/integration/README.md`. Validates on Linux Blacksmith runners + macOS dev laptops without root.
4. README updates: install + upgrade flow, doctor verbs.
5. `docs/security/cosign-trust.md`: tier model, identity_chain, self-signing.
6. CHANGELOG entry naming: socket path canonical-ization, port 5432, no bun bridge, blocklist mechanism, tiered doctor, cosign tier on top of host_signed, **breaking-version bump rationale + accept-downtime contract** (TCP 8432 dies; out-of-trio consumers break silently; this is intentional for a major bump).
7. **Consumer fan-out smoke test** (`tests/integration/consumer-fanout.sh`): on a canary host with all 6+ consumers installed (genie, omni, brain, rlmx, hapvida-eugenia, email), run `pgserve update` and verify each consumer can re-establish DB connection (operator may need to update consumer config first; test verifies which consumers need updates).

**Acceptance Criteria:**
- [ ] `bun test` passes.
- [ ] `bun run lint` and `typecheck` clean.
- [ ] CHANGELOG entry with literal contract sentences.
- [ ] Cosign trust doc walks through self-signing example.

**Validation:**
```bash
bun test
bun run lint
bun run typecheck
test -f docs/security/cosign-trust.md
```

**depends-on:** Group 8

---

## Cross-wish dependencies

- **paired-with** `automagik-dev/genie#pgserve-singleton-no-proxy` — consumer-side wiring; ships in lockstep.
- **paired-with** `automagik/omni#pgserve-singleton-no-proxy` — consumer-side wiring; ships in lockstep.
- **builds-on** `pgserve-canonical-cutover` (genie merged) — consumer-only foundation.
- **builds-on** `pgserve-host-signed-identity` (genie merged, pgserve pending) — host_signed Tier 1 stays; cosign Tier 2 layered on top.
- **builds-on** `update-unify-stages` (all merged) — pre-flight + decideVerify + diagnostics inherited.
- **builds-on** `genie-supply-chain-signing` — reuses `--unsafe-unverified <INCIDENT_ID>` typed-ack.

## QA Criteria

- [ ] Functional — `pgserve install` on fresh host: postgres listens on Unix socket + TCP 5432; no bun bridge.
- [ ] Functional — `pgserve update` from synthetic v2.2.x layout: full reconfiguration.
- [ ] Functional — `pgserve provision` for both signed and unsigned apps: correct role/DB; isolation enforced.
- [ ] Functional — `pgserve verify` for cosign-signed binary: cache persisted; subsequent verify uses cache.
- [ ] Functional — `pgserve gc` cron entry removes orphans; preserves active.
- [ ] Functional — `pgserve doctor --fix` tiered modes behave per spec.
- [ ] Functional — `pgserve grant` cross-DB only between cosign-tier publishers.
- [ ] Functional — Hardcoded blocklist refuses test-blocked version.
- [ ] Integration — Companion genie + omni consume canonical socket; no leftover 8432 references.
- [ ] Integration — Existing host_signed handshake continues to work.
- [ ] Regression — All existing pgserve tests pass byte-identically.
- [ ] Cross-repo — Smoke test on canary host validates 3-way interop.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing hosts with custom postgres args lose them on migration | Medium | Detection logic preserves operator-supplied args; only changes `-k` and `-p`. |
| Cosign verify slow enough to add perceptible latency | Medium | HMAC cache short-circuits 99% of provisions. First verify ~200ms; cached <5ms. |
| Local re-builds of pgserve fail cosign verify | Low | `pgserve trust add --offline-cosign-key` for local-build flow. |
| pm2 reconfiguration races with operator's `pm2 restart pgserve` | Medium | Migration acquires `pgserve.pid` advisory lock first. |
| `pgaudit` extension increases postgres binary size | Low | Already part of embedded postgres bundle. Verify size delta. |
| Old socket dir archives grow unboundedly | Low | Document cleanup recipe. Future `pgserve gc --legacy-archives`. |
| Some operators rely on TCP 8432 in scripts | Medium | TCP 5432 is canonical; 8432 dies. CHANGELOG warns explicitly. |
| `--skip-sigstore` becomes default in CI by accident | Low | Refuses unless `--offline-cosign-key` pretrusted; emits warning; audit-log entry. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modify
bin/postgres-server.js
bin/pgserve-wrapper.cjs
src/cli-install.cjs
package.json
CHANGELOG.md
README.md

# Create
src/cosign/verify.js
src/cosign/trust-list.js
src/cosign/cache-token.js
src/upgrade/steps/data-plane-cutover.js
src/upgrade/steps/blocklist-check.js
src/cli/provision.js
src/cli/gc.js
src/cli/trust.js
src/cli/doctor.js
src/cli/grant.js
src/cli/verify.js
src/cli/requirements.js
src/sql/role-template.sql
src/sql/pg_hba.template
src/sql/pg_ident.template
config/pgaudit.conf
config/logrotate.d/pgserve
docs/security/cosign-trust.md
tests/integration/upgrade-from-2.2.x.sh
tests/integration/migration-from-old-layout.sh
tests/integration/migration-rollback-on-failure.sh
tests/cli/provision.test.js
tests/cli/gc.test.js
tests/cli/trust.test.js
tests/cli/doctor.test.js
tests/cli/verify.test.js
tests/cosign/cache-token.test.js
tests/migrations/cosign-tier-additive.test.js
tests/sql/roles-grants.test.js
tests/sql/peer-auth.test.js
tests/sql/cross-db-grant.test.js
tests/blocklist.test.js
tests/update/active-connection-prompt.test.js
```
