# Wish: pgserve v2 — portless, fingerprinted, dogfooded

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pgserve-v2` |
| **Date** | 2026-04-26 |
| **Author** | Felipe Rosa (via genie-pgserve agent) |
| **Appetite** | large (~3-4 weeks; 8 execution groups across 6 waves + parallel dogfood loop) |
| **Branch** | `wish/pgserve-v2` |
| **Design** | [DESIGN.md](../../brainstorms/pgserve-v2/DESIGN.md) |

## Summary

Cut **pgserve v2.0.0** — breaking semver bump that bundles GC, singleton daemon mode, Unix-socket-by-default, kernel-rooted package.json fingerprint, database-per-fingerprint enforcement, opt-in TCP, and `pgserve.persist: true` flag. Drop the staged ABI-compat plan from the original design (`pgserve-roadmap-design.md`) in favor of one clean cut. Validate the cut by migrating the `automagik-dev/genie` consumer in lockstep — a dedicated dogfooder twin agent runs a real genie dev environment against pgserve v2 throughout the build, reporting breakage daily. Other 5 consumer apps (brain, omni, rlmx, hapvida-eugenia, email) remain on v1.x and migrate in separate per-app wishes after v2 ships.

## Scope

### IN

- Singleton pgserve daemon mode — one process per host, supervised, listening on `$XDG_RUNTIME_DIR/pgserve/control.sock` (fallback `/tmp/pgserve/control.sock`).
- Per-pid sockets remain for direct embed; PR #24's invariants (`_stopping` flag, exit-handler reset, router fallback-on-missing-socket) regression-tested.
- SO_PEERCRED-based identity: read peer (pid, uid, gid) from kernel on Unix socket connect.
- Walk `/proc/$pid/cwd` to nearest-ancestor `package.json`; fingerprint = `sha256(realpath(package.json) + name + uid).slice(0, 12)`.
- Script fallback fingerprint: `sha256(uid + cwd + cmdline[1]).slice(0, 12)`.
- Database-per-fingerprint: `app_<sanitized-name>_<12hex>`, auto-created on first connect.
- `pgserve_meta` control table in pgserve admin DB (schema in DESIGN.md §9).
- 3-layer lifecycle: ephemeral default + liveness signal + 24h TTL; `pgserve.persist: true` in package.json overrides.
- GC sweep: on-connect (sampled) + hourly + on-startup; one `gcSweep()` function, three call sites.
- Enforcement default-ON with `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` deprecation kill switch.
- Audit log: `~/.pgserve/audit.log` JSONL default, `pgserve.audit.target: "syslog"` opt-in (webhook deferred to v2.1).
- `--listen :PORT` opt-in TCP for k8s/remote use.
- Migration: `automagik-dev/genie` repo updated to consume pgserve v2 — proves zero TCP ports + zero credentials + visible fingerprint in DB name.
- Dogfooder twin agent spawned at wish start, runs genie dev environment against work-in-progress builds, reports daily.
- Release: `pgserve@2.0.0` published to npm; CHANGELOG includes migration guide for v1 consumers.

### OUT

- Migration of brain, omni, rlmx, hapvida-eugenia, email consumer apps (one wish per app, dispatched after v2 ships).
- One-time inventory + classification + cleanup of existing 240 orphans on prod hosts (separate ops task).
- Backward-compat default TCP listener — replaced by `--listen` opt-in (clean break, hence v2 major).
- Multi-host coordination — pgserve v2 is single-host by design.
- Cross-DB foreign keys / cross-app SELECT — still impossible, by design.
- `pgserve.audit.target: "url"` (HTTP webhook) — deferred to v2.1.
- `pgserve.fingerprintRoot: "monorepo-root"` escape hatch — deferred until demand surfaces.
- Encryption-at-rest, TLS for control socket, multi-tenant role permissions — separate hardening wishes.
- Cosign + SLSA provenance — separate supply-chain hardening wish.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Single v2.0.0 cut, not the original 5-stage ABI-compat rollout | Felipe 2026-04-26: cycle time over compat. Align breaking semver with actual breaking change. Dogfood loop is the safety net — `automagik-dev/genie` migrates in lockstep. |
| 2 | Portless default — Unix socket only at well-known control path | Eliminates port conflicts (#1 embedded-server failure mode); enables SO_PEERCRED for kernel-rooted identity. |
| 3 | Identity tuple = `(realpath(package.json), name, uid)` hashed to 12 hex | Stable across npm install, runtime swap, git pull, sub-cd. Birthday-bound at ~16M projects. |
| 4 | Database-per-fingerprint, NOT schema-per | Real mechanical isolation under shared superuser; atomic GC via DROP DATABASE; pg_dump/drizzle/prisma compat preserved. |
| 5 | Default-ON enforcement with `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` deprecation kill switch | Happy path stays simple; ops gets one panic button. |
| 6 | 3-layer lifecycle (ephemeral / liveness+TTL / `persist:true`) | Cures 240-orphan disease at source; zero new cognitive overhead for devs who don't need persist. |
| 7 | GC: opportunistic + hourly + boot, single sweep function | Bounds worst-case orphan lifetime ≤ 1h on idle; near-instant on active hosts. |
| 8 | Audit tiered (file default → syslog opt-in → webhook v2.1) | Zero-config promise honored; ops opts into separate sink. |
| 9 | Monorepo: nearest-ancestor package.json wins (matches `require.resolve`) | Familiar Node mental model. Workspace edge case documented. |
| 10 | Dogfood `automagik-dev/genie` in parallel from t=0 | Empirical safety net for the breaking cut; first canary before broader migration. |
| 11 | DELETE PR #16 schema/role machinery | Replaced by database boundary + peer-creds routing. |
| 12 | Pin v1.x for non-genie consumers (brain/omni/rlmx/eugenia/email) until each gets a migration wish | Prevents accidental breakage during the v2 rollout window. |

## Success Criteria

- [ ] `pgserve@2.0.0` published to npm with provenance (no `NPM_TOKEN`, OIDC only — already in place from `release-system-genie-pattern`).
- [ ] `automagik-dev/genie` repo running against pgserve v2 in dev mode, verified by:
  - [ ] No TCP ports bound by pgserve daemon (`ss -tlnp | grep -i pgserve` returns empty unless `--listen` is set).
  - [ ] No credentials in genie's env or code paths (libpq connstring uses Unix socket via `host=/run/.../pgserve` or equivalent).
  - [ ] `psql -l` shows genie's DB named `app_<sanitized-name>_<12hex>` with the visible fingerprint.
- [ ] Dogfooder twin reports PASS on the scenario suite (defined in Group 0 below) covering: connect, fingerprint mismatch denied, persist-flag honored, TTL reaped, `--listen` TCP fallback, kill-switch bypass.
- [ ] `pgserve_meta` schema present; every user DB has a row at creation time.
- [ ] Synthetic 240-orphan fixture reduced to 0 after first sweep (test under `tests/multi-tenant.test.js` or new file).
- [ ] Audit log populated with all 7 event types under realistic workload.
- [ ] PR #24's invariants regression-tested in a dedicated test in the daemon group (no socketDir leak across stop/start cycles, double-start no-op, exit-handler resets state).
- [ ] CHANGELOG includes a v1→v2 migration guide for consumers (env var changes, persist flag introduction, TCP opt-in, breakage list).
- [ ] README updated: zero-config promise restated for v2 (still `npx pgserve`); fingerprint behavior documented; persist flag documented.
- [ ] All 6 Namastex apps explicitly pinned to `pgserve@^1.x` until their migration wishes ship.

## Execution Strategy

| Wave | Groups | Parallel? | Notes |
|------|--------|-----------|-------|
| **0** | **0** (dogfooder twin spawn + scenario harness scaffold) | Independent — runs continuously from t=0 | Sets up genie dev env, scenario suite skeleton; idle-watches for builds to consume |
| **1** | **1** (control DB + `pgserve_meta` schema + audit log infra) | Sequential foundation | Foundation for all later groups |
| **2** | **2** (singleton daemon + control socket + PR #24 regression) ‖ **3** (fingerprint derivation + SO_PEERCRED) | Yes — disjoint surfaces | Group 2 = transport layer; Group 3 = identity layer |
| **3** | **4** (database-per-fingerprint + enforcement + kill switch) | Sequential after Wave 2 | Wires identity to tenancy |
| **4** | **5** (lifecycle + persist + GC sweep) ‖ **6** (`--listen` opt-in TCP) | Yes — disjoint surfaces | Group 5 = lifecycle; Group 6 = transport opt-in |
| **5** | **7** (`automagik-dev/genie` consumer migration) | Sequential — proof | Migrates genie repo to consume pgserve v2; dogfooder validates |
| **6** | **8** (release prep — semver 2.0.0, CHANGELOG, migration guide, README, npm publish) | Sequential — ship gate | Final release through `release-system-genie-pattern` workflow |

Group 0 runs in parallel throughout — its job is to consume each Wave's output as it lands and report breakage to the engineer group leads via `genie send`.

---

## Execution Groups

### Group 0: Dogfooder twin spawn + scenario harness

**Goal:** Stand up an independent genie agent (the "dogfooder twin") that runs a local `automagik-dev/genie` dev environment against pgserve v2 work-in-progress builds throughout this wish, exercises a defined scenario suite, and reports breakage continuously to the engineer working each group.

**Deliverables:**
1. Spawn dogfooder twin via `genie spawn dogfooder --team genie` with cwd `/home/genie/workspace/repos/genie`. Brief: consume pgserve v2 from `npm pack` of the active feature branch, run scenario suite daily, report PASS/FAIL via `genie send` to the engineer.
2. Scenario suite scaffold at `genie/.genie/dogfood/pgserve-v2/scenarios.md`, covering:
   - **S1 connect**: genie boots, requests a DB, gets one (named with fingerprint), CRUD a row, disconnect.
   - **S2 fingerprint mismatch denied**: genie boots from `/tmp/fake-project` (different package.json) — must NOT reach the real genie DB; gets a fresh fingerprint instead.
   - **S3 persist honored**: package.json has `pgserve.persist: true`; kill genie process, wait 25h (or fast-forward via test hook), restart genie, original DB still present.
   - **S4 TTL reaped**: package.json has no persist flag; kill genie, wait 25h, restart with same fingerprint — DB was reaped, fresh empty one provisioned.
   - **S5 `--listen` TCP fallback**: pgserve started with `--listen :5432`; genie configured with `host=localhost port=5432` instead of socket — connects.
   - **S6 kill-switch bypass**: `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` env, two genie processes from different fingerprints — second reaches first's DB (proves the kill switch is a real bypass; deprecation warning logged).
3. Each scenario script callable as `bun .genie/dogfood/pgserve-v2/scenarios/sN.ts`, returns exit 0 on PASS / non-zero on FAIL with diagnostic.
4. Daily summary cron from twin: post a one-line status to genie team-lead `genie send "dogfood D=$(date +%Y%m%d): S1✅ S2✅ S3⚠ S4✅ S5✅ S6✅" --to team-lead`.

**Acceptance Criteria:**
- [ ] Twin agent visible in `genie ls --json` with `team: genie`, `status: idle` or `running`.
- [ ] Scenario harness exists at the documented path, all 6 scripts present (may be stubs that return WIP until matching wave ships).
- [ ] Twin posts at least one daily status during the wish lifecycle.
- [ ] After Wave 5 (Group 7) ships, all 6 scenarios return PASS.

**Validation:**
```bash
genie ls --json | jq '.[] | select(.name=="dogfooder")'
test -f /home/genie/workspace/repos/genie/.genie/dogfood/pgserve-v2/scenarios.md
ls /home/genie/workspace/repos/genie/.genie/dogfood/pgserve-v2/scenarios/ | wc -l   # expect 6
```

**depends-on:** none (runs from t=0 in parallel with Wave 1)

---

### Group 1: Control DB schema + audit log infrastructure

**Goal:** Land the foundational `pgserve_meta` table in pgserve's admin DB, plus the JSONL audit log writer with rotation. Both are prerequisites for every later group's metadata writes and visibility events.

**Deliverables:**
1. New module `src/control-db.js` exposing:
   - `ensureMetaSchema(client)` — idempotently creates `pgserve_meta` table per DESIGN.md §9 schema.
   - `recordDbCreated({ databaseName, fingerprint, peerUid, packageRealpath, livenessPid, persist })`.
   - `touchLastConnection({ databaseName, livenessPid })`.
   - `markPersist(databaseName, value)`.
   - `forEachReapable({ now }) -> AsyncIterable<{databaseName, fingerprint, lastConnectionAt, livenessPid}>` (used by Group 5 sweep).
2. New module `src/audit.js` exposing:
   - `audit(event, fields)` — appends one JSON line to `~/.pgserve/audit.log`.
   - File rotation at 50MB × 5 files (use a thin in-process rotator, no external dep).
   - Event types defined as a TypeScript-style JSDoc enum: `db_created | db_reaped_ttl | db_reaped_liveness | db_persist_honored | connection_routed | connection_denied_fingerprint_mismatch | enforcement_kill_switch_used`.
3. `src/audit.js` reads `pgserve.audit.target` from the active package.json (when daemon resolves a peer's package.json in Group 3); supported values: `"file"` (default), `"syslog"`. Webhook deferred to v2.1.
4. Tests in `tests/control-db.test.js` and `tests/audit.test.js`:
   - schema idempotency, insert/update/select round-trip, rotation triggers at 50MB, syslog target spawns `logger -t pgserve-audit` per event.

**Acceptance Criteria:**
- [ ] `src/control-db.js` and `src/audit.js` exist and export the documented surface.
- [ ] `bun test tests/control-db.test.js tests/audit.test.js` green.
- [ ] `~/.pgserve/audit.log` written on test run; rotated when size threshold crossed.
- [ ] No external runtime deps added (rotation is in-process).

**Validation:**
```bash
bun test tests/control-db.test.js tests/audit.test.js
test -f src/control-db.js && test -f src/audit.js
node -e "console.log(Object.keys(require('./src/audit.js')))" | grep -q audit
```

**depends-on:** none

---

### Group 2: Singleton daemon + well-known control socket + PR #24 regression

**Goal:** Add daemon mode to pgserve. One process per host, accepts client connections on `$XDG_RUNTIME_DIR/pgserve/control.sock` (or fallback). Preserve every invariant from PR #24's socketDir lifecycle fix.

**Deliverables:**
1. New CLI subcommand `pgserve daemon` (long-running) and `pgserve daemon stop`.
2. Singleton lock file at `${controlSocketDir}/pgserve.pid` — `flock` exclusive; second invocation of `pgserve daemon` exits with "already running, pid N".
3. Control socket server in `src/daemon.js`:
   - Bind `$XDG_RUNTIME_DIR/pgserve/control.sock` (mode 0700) — fallback `/tmp/pgserve/control.sock` if XDG_RUNTIME_DIR unset.
   - Reuse `PostgresManager` lifecycle from `src/postgres.js` for the underlying PG instance — singleton per daemon.
   - On SIGTERM: graceful shutdown, unlinks socket and lock file.
4. Router updates in `src/router.js`:
   - When connecting client provides only a libpq connstring like `host=/path/to/socket`, the router strips it and connects to the daemon's control socket instead, then proxies through.
   - Per-pid socket fallback path (existing) untouched — direct-embed callers still get per-pid sockets.
5. **Regression tests for PR #24** in `tests/daemon-pr24-regression.test.js`:
   - `stop()` nulls socketDir.
   - `start()`+`stop()`+`start()` yields fresh socketDir, no leak, new path.
   - Double `start()` is a no-op (re-entry guard preserved).
   - Daemon mode does NOT introduce a new socketDir leak path under abnormal exit (kill -9): orphaned socket file + lock file are cleaned by the next `pgserve daemon` boot via stale-pid detection.
6. README section "Running as daemon" — single-page how-to with PM2 + systemd snippets.

**Acceptance Criteria:**
- [ ] `pgserve daemon` boots, binds control socket, accepts a `psql -h $XDG_RUNTIME_DIR/pgserve` connection (after Group 4 wires routing).
- [ ] Second `pgserve daemon` invocation refuses with "already running, pid N".
- [ ] `pgserve daemon stop` graceful — unlinks socket + lock.
- [ ] All 4 regression tests pass.
- [ ] No regression in existing test suite (`bun test`).

**Validation:**
```bash
bun test tests/daemon-pr24-regression.test.js
bun test tests/multi-tenant.test.js   # PR #24's original tests
pgserve daemon &; sleep 1; test -S "${XDG_RUNTIME_DIR:-/tmp}/pgserve/control.sock"; pgserve daemon stop
```

**depends-on:** Group 1

---

### Group 3: Fingerprint derivation + SO_PEERCRED

**Goal:** Land the kernel-rooted identity layer. On every accept on the daemon's control socket, derive a 12-hex fingerprint for the peer.

**Deliverables:**
1. New module `src/fingerprint.js` exposing:
   - `getPeerCred(socket): {pid, uid, gid}` — reads SO_PEERCRED via `node:net`'s underlying handle (bun supports this; verify on macOS — fall back to `getpeereid` if needed).
   - `findNearestPackageJson(startCwd: string): string | null` — synchronous walk up to filesystem root, returns realpath of nearest `package.json`.
   - `derivePackageFingerprint({ packageRealpath, name, uid }): string` — `sha256(packageRealpath + '\0' + name + '\0' + String(uid)).slice(0, 12)`.
   - `deriveScriptFingerprint({ uid, cwd, cmdline1 }): string` — fallback when no package.json found.
   - `fingerprintForPeer(socket): { fingerprint, packageRealpath, name, uid, mode: 'package' | 'script' }`.
2. Integration in `src/daemon.js`:
   - On every new control-socket accept: read peer creds → walk `/proc/$pid/cwd` → find nearest package.json (or script fallback) → compute fingerprint → log `connection_routed` audit event.
3. Tests in `tests/fingerprint.test.js`:
   - Stable across `cwd` change in the same project.
   - Different across two projects with same `name` field but different paths.
   - Different across same path but different `uid`.
   - Script fallback triggered when no package.json above cwd.
   - Monorepo: nested package.json wins (deepest match).

**Acceptance Criteria:**
- [ ] `src/fingerprint.js` exports the documented surface.
- [ ] All 5 tests pass.
- [ ] Daemon logs `connection_routed` with fingerprint for every accept.
- [ ] macOS support verified via dogfooder twin's S1 scenario when twin runs on macOS-arm64 (or explicit deferral note in CHANGELOG).

**Validation:**
```bash
bun test tests/fingerprint.test.js
# Connect a real client, check audit log:
psql -h "${XDG_RUNTIME_DIR:-/tmp}/pgserve" -c 'select 1' >/dev/null
tail -1 ~/.pgserve/audit.log | jq -e '.event=="connection_routed" and (.fingerprint|length==12)'
```

**depends-on:** Group 1

---

### Group 4: Database-per-fingerprint + enforcement + kill switch

**Goal:** Wire identity (Group 3) to tenancy. Daemon auto-creates a DB per fingerprint on first connect, routes the peer's session into it, denies cross-fingerprint reads. Honor the kill-switch env var.

**Deliverables:**
1. In `src/daemon.js`, on accept after Group 3 fingerprint derivation:
   - Look up `pgserve_meta` for `fingerprint`. If absent: `CREATE DATABASE app_<sanitize(name)>_<12hex>`, `INSERT INTO pgserve_meta`, audit `db_created`.
   - Rewrite the peer's libpq startup-message `database` parameter to the resolved DB name (proxy logic).
   - Update `pgserve_meta.last_connection_at = now()`, `liveness_pid = peer.pid`.
2. Enforcement: if peer attempts to connect to a `database=X` that does NOT match its fingerprint's row:
   - With enforcement ON (default): close the connection with an error frame `28P01 invalid_authorization — database fingerprint mismatch`. Audit `connection_denied_fingerprint_mismatch`.
   - With `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`: proxy through anyway. Audit `enforcement_kill_switch_used` (deprecated; warning logged at daemon boot if env var observed).
3. Sanitizer: `sanitize(name)` replaces non-`[a-z0-9]` runs with `_`, lowercases, truncates to 30 chars to keep DB name ≤ 63 chars.
4. Tests in `tests/tenancy.test.js`:
   - Two peers with different fingerprints get different DBs.
   - Same peer reconnecting reaches its existing DB.
   - Cross-fingerprint connection attempt denied with the correct SQLSTATE.
   - Kill-switch env: cross-fingerprint succeeds + audit event logged.
   - Sanitization: name `"@scope/foo bar"` → `_scope_foo_bar`.

**Acceptance Criteria:**
- [ ] `bun test tests/tenancy.test.js` green.
- [ ] Manual cross-fingerprint test: spin up two `psql` clients with different cwds, second-one's queries against first's DB return SQLSTATE `28P01`.
- [ ] Kill-switch path emits `enforcement_kill_switch_used` audit event.
- [ ] Daemon boots with deprecation warning on stderr when env var is set.

**Validation:**
```bash
bun test tests/tenancy.test.js
# Spin two clients from /tmp/proj-a (package.json name=a) and /tmp/proj-b (name=b)
# Confirm each gets app_a_<hex> and app_b_<hex>; cross attempt from a-client targeting b-db is denied.
```

**depends-on:** Group 2, Group 3

---

### Group 5: Lifecycle + persist flag + GC sweep

**Goal:** Implement the 3-layer lifecycle. Default ephemeral (liveness + 24h TTL since last connection); `pgserve.persist: true` in package.json overrides. GC sweep called on-connect (sampled), hourly, and on daemon startup.

**Deliverables:**
1. In `src/daemon.js` accept hook (Group 4 path), after fingerprint derivation: read `pgserve.persist` from the resolved package.json; set/update `pgserve_meta.persist`.
2. New `src/gc.js`:
   - `gcSweep({ now, dryRun=false })` — iterates `forEachReapable`, decides reap-or-keep per row:
     - skip if `persist=true`.
     - skip if liveness alive (`/proc/$liveness_pid` exists) — touches `last_connection_at` to slide window.
     - reap if liveness dead AND `now - last_connection_at > 24h` → `DROP DATABASE` + `DELETE FROM pgserve_meta` + audit `db_reaped_ttl` or `db_reaped_liveness`.
   - `installSweepTriggers(daemon)` — hourly timer + on-connect (sample 1/N where N = max(1, dbCount/10)) + boot-time call once at daemon startup.
3. Synthetic 240-orphan fixture at `tests/fixtures/240-orphan-seed.sql` plus harness `tests/orphan-cleanup.test.js`:
   - Seed 240 DBs with stale `last_connection_at` and dead `liveness_pid`.
   - Run one sweep.
   - Assert all 240 reaped, audit log has 240 `db_reaped_*` entries.
4. Tests for the persist override and the slide-window-on-active-pid path.

**Acceptance Criteria:**
- [ ] `bun test tests/orphan-cleanup.test.js` green; 240 → 0 in one sweep.
- [ ] Persist-flagged DB never reaped even past TTL.
- [ ] On-connect sweep does not block accept latency past 50ms (P99 measured in test).
- [ ] Daemon logs first sweep at boot with summary counts.

**Validation:**
```bash
bun test tests/orphan-cleanup.test.js
# Inspect audit log
grep -c db_reaped_ ~/.pgserve/audit.log   # >= 240 after the test
```

**depends-on:** Group 1, Group 4

---

### Group 6: `--listen` opt-in TCP

**Goal:** Bring back TCP — but as opt-in only. Ops who need k8s pods or remote sync set `pgserve daemon --listen :PORT` (or `--listen :5432`). Identity model still applies: TCP peers cannot use SO_PEERCRED, so they MUST present a credential; default deny otherwise.

**Deliverables:**
1. Daemon CLI accepts `--listen [host:]port` (repeatable for multiple binds).
2. TCP accept hook: requires `?fingerprint=<hex>&token=<bearer>` style auth in libpq application_name, OR a `pgserve.toml` allowlist mapping fingerprints to bearer tokens. Tokens hashed at rest. Without auth: connection refused.
3. Auth tokens issued via `pgserve daemon issue-token --fingerprint <hex>` CLI command — prints token once, hashes into `pgserve_meta.allowed_tokens` jsonb column (added in this group's schema migration).
4. Audit events: `tcp_token_issued`, `tcp_token_used`, `tcp_token_denied` added to the audit enum.
5. Tests:
   - TCP connect without token denied.
   - TCP connect with correct token reaches the right fingerprint's DB.
   - Token revoke via `pgserve daemon revoke-token <id>` works.

**Acceptance Criteria:**
- [ ] `pgserve daemon --listen :5432` binds; `ss -tlnp | grep 5432` shows pgserve.
- [ ] Test suite covers all three TCP paths (deny, allow, revoke).
- [ ] Audit log has `tcp_*` events.
- [ ] Without `--listen`, no TCP port bound (verify via `ss -tlnp`).

**Validation:**
```bash
bun test tests/tcp-listen.test.js
pgserve daemon --listen :5432 &; sleep 1
ss -tlnp | grep -q 5432
pgserve daemon stop
```

**depends-on:** Group 2

---

### Group 7: `automagik-dev/genie` consumer migration (the dogfood proof)

**Goal:** Migrate the `automagik-dev/genie` repo to consume pgserve v2. This is THE proof. Removes all pgserve TCP host/port/credential references, switches to Unix socket, relies on auto-fingerprint. Dogfooder twin's S1–S6 must all return PASS after this group ships.

**Deliverables:**
1. In `automagik-dev/genie` repo (separate PR, depends-on this wish merging first):
   - Remove all `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` references where they exist purely for pgserve.
   - Update libpq connstring helper to default to `host=$XDG_RUNTIME_DIR/pgserve` (no port, no user, no password).
   - Add `pgserve.persist: true` to genie's package.json (genie holds long-lived state — wishes, agents, events).
   - Pin `pgserve@^2.0.0` in `package.json`.
2. Genie's startup banner prints the resolved DB name once (so dev sees the visible fingerprint).
3. Smoke test in genie's CI: `genie wish list` round-trips through pgserve v2 successfully.
4. Migration note in genie's CHANGELOG.

**Acceptance Criteria:**
- [ ] `automagik-dev/genie` PR merged.
- [ ] Dogfooder twin's S1–S6 all PASS after this group ships.
- [ ] `genie wish list` works in genie's CI against pgserve v2.
- [ ] No port bound (`ss -tlnp` clean) when genie is the only pgserve consumer.

**Validation:**
```bash
# In automagik-dev/genie repo:
grep -rE 'PGHOST|PGPORT|PGUSER|PGPASSWORD' src/ packages/ 2>/dev/null   # zero hits expected (or only in test fixtures)
jq '.dependencies.pgserve' package.json                                   # ^2.0.0
genie wish list >/dev/null && echo OK
```

**depends-on:** Group 4, Group 5

---

### Group 8: Release prep — semver 2.0.0, CHANGELOG, migration guide, npm publish

**Goal:** Ship `pgserve@2.0.0` to npm. Migration guide for v1 consumers. README updated. Pin guidance for the 5 non-genie consumer apps.

**Deliverables:**
1. `npm version major` → `2.0.0`. Commit with `[skip ci]`-aware message; tag.
2. CHANGELOG entry for v2.0.0:
   - Breaking changes list (TCP no longer default, fingerprint enforcement default-ON, etc).
   - Migration guide: connstring changes, `pgserve.persist` flag, `--listen` for TCP, kill switch env var.
   - Pin guidance: "Existing consumers should pin `pgserve@^1.x` in package.json until they migrate."
3. README:
   - Headline still "npx pgserve and it just works, no credentials needed".
   - New section "Fingerprint isolation" — what it is, what `\l` will show, monorepo rules.
   - New section "Daemon mode" — PM2/systemd snippets.
   - Section "Long-running apps: pgserve.persist" — when and how.
   - Section "Compat TCP via --listen" — when to use it.
4. Trigger the existing release workflow (`gh workflow run release.yml -f bump=major`) — this consumes the work from Group 1 of `release-system-genie-pattern` (already SHIPPED).
5. Verify `npm view pgserve@latest version` returns `2.0.0`, GitHub Release exists with binaries for Linux x64 / macOS arm64 / Windows x64.

**Acceptance Criteria:**
- [ ] `pgserve@2.0.0` published to npm with provenance.
- [ ] GitHub Release `v2.0.0` exists with all 3 binary assets.
- [ ] CHANGELOG migration guide present and accurate.
- [ ] README updated and lints clean.
- [ ] Dogfooder twin posts final status: all scenarios PASS on the published artifact.

**Validation:**
```bash
npm view pgserve@latest version   # 2.0.0
gh release view v2.0.0 --json tagName,assets -q '{tag: .tagName, assets: [.assets[].name]}'
test -f CHANGELOG.md && grep -q "## 2.0.0" CHANGELOG.md
```

**depends-on:** Group 7

## Dependencies

- depends-on: none external. (`release-system-genie-pattern` is already SHIPPED — its workflow is this wish's release vehicle.)
- blocks: per-app migration wishes for `brain`, `omni`, `rlmx`, `hapvida-eugenia`, `email` consumers — those wishes can be drafted now but cannot ship until pgserve@2.0.0 is on npm.

## QA Criteria

After merge to `main` and release of `pgserve@2.0.0`:
- [ ] On a fresh dev host, `npx pgserve@2 daemon &` boots cleanly without prompts.
- [ ] A throwaway `mkdir /tmp/foo && cd /tmp/foo && npm init -y && bun -e "import pg from 'postgres'; const sql = pg('postgres://postgres:postgres@/test?host=/run/user/$UID/pgserve'); console.log(await sql\`select 1\`); await sql.end()"` works without further config.
- [ ] `psql -l` from the daemon-owning user shows `app_foo_<12hex>`.
- [ ] Audit log under `~/.pgserve/audit.log` shows the connect events.
- [ ] No bound TCP port (verified via `ss -tlnp`).

## Assumptions / Risks

- **Assumption:** `automagik-dev/genie` is the right canary. Its data model is non-trivial (wishes, agents, events) and it's actively developed — high signal-to-noise. If turns out genie under-exercises a code path that brain/email rely on, dogfood loop won't catch it. Mitigation: Group 7 includes a smoke test that exercises every audit event, not just connect.
- **Assumption:** macOS support for SO_PEERCRED via Bun is available. If not, fall back to `getpeereid` syscall via FFI; if that's also blocked, document as Linux-only for v2.0 and revisit for v2.1.
- **Risk: brain/omni/rlmx/eugenia/email apps accidentally upgrade to v2.0** before their migration wishes run → outage. Mitigation: Group 8 migration guide explicitly tells consumers to pin `^1.x`; we also send notice to each repo's owner before publish.
- **Risk: `automagik-dev/genie` migration reveals a fundamental design flaw** mid-build. Mitigation: dogfooder twin reports daily; if a Wave 4+ scenario fails irreparably, pause wish, reconvene `/council`, possibly revert to the original staged plan.
- **Risk: PR #24 invariants regress in Group 2 daemon work.** Mitigation: explicit regression test required in Group 2's deliverables.
- **Risk: 24h TTL is wrong for some workloads.** Mitigation: `pgserve.persist: true` covers production; for dev workloads with long debug cycles, document that any new connection slides the window. If real friction emerges, expose `pgserve.ttlHours` in v2.1.
- **Risk: daemon as single point of failure.** Mitigation: supervised by PM2/systemd per the README snippets; pgserve already tolerates restarts (per-app spawn pattern was effectively the same SPF).
- **Risk: dogfooder twin idle-burns tokens** while waiting for early-wave builds. Mitigation: twin has explicit instruction to sleep 1800s between scenario runs and only spike on a `genie send` trigger from the engineer.
- **Risk: Bun + Node compatibility for SO_PEERCRED.** Verify in Group 3; if Bun blocks the syscall surface, must drop in a small native addon or use `getpeereid` fallback.
