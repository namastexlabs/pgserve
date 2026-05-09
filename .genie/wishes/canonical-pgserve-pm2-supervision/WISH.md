# Wish: Canonical pgserve + PM2 supervision across genie/omni/pgserve

| Field | Value |
|-------|-------|
| **Status** | DRAFT (one of three peer wishes that together ship v2.4; each gets its own branch + PR + `/dream` slot) |
| **Slug** | `canonical-pgserve-pm2-supervision` |
| **Date** | 2026-04-30 (refined 2026-05-08 for v2.4 cohort + autopg rename) |
| **Author** | genie-configure |
| **Appetite** | medium-large |
| **Branch** | `wish/canonical-pgserve-pm2-supervision` |
| **Repos touched** | `automagik/autopg` (renamed from `namastexlabs/pgserve` in cohort sibling), `automagik-dev/omni`, `automagik-dev/genie`, `namastexlabs/genie-configure` (brain only) |
| **Design** | _No brainstorm — direct wish from operational pain (live debugging session 2026-04-30)_ |
| **v2.4 cohort** | peer wishes, separate branches/PRs: `autopg-distribution-cutover` (rename + CDN + Tier B G20), `pgserve-singleton-no-proxy` (data plane + admin.json), this wish (cross-repo pm2 reuse — Tier A only) |

> **🛡 TWO-TIER SUPERVISOR MODEL (Felipe constraint, 2026-05-08)**: this wish **specifies Tier A only** (rootless pm2). Tier B systemd-user / launchd is delivered by the cohort sibling `autopg-distribution-cutover` G20 via `autopg service install`. The hard MIGRATE contract (pm2-delete BEFORE unit-write; `~/.autopg/admin.json` records active supervisor) prevents Tier A + Tier B double-supervision. This wish writes `admin.json.supervisor = "pm2"` and downstream installers (`genie install`, `omni install`) MUST refuse to register their own pm2 entries if `admin.json.supervisor == "systemd-user"` (operator must run `autopg service uninstall` first to revert to Tier A).

## Summary

Canonicalize **pgserve as the single, central, pm2-supervised database server** that every service in the stack connects to. Make `genie serve` and `omni-api`/`omni-nats` peer-equal pm2 services that boot under the same hardening, register via their own `*-install` commands, and consume pgserve through its CLI.

**End-state pm2 list (v2.4, Tier A — rootless default):**

```
┌──────────────────────────────────────────────┐
│  pm2 supervisor (Tier A)                     │
├──────────────────────────────────────────────┤
│  1. autopg-server    ← NEW (canonical PG)    │
│  2. autopg-ui        ← NEW (console, opt.)   │
│  3. omni-api         ← existing, reconfig    │
│  4. omni-nats        ← existing               │
│  5. genie-serve      ← NEW                    │
│                                               │
│  + pm2-logrotate (module, already there)     │
└──────────────────────────────────────────────┘
```

When the operator has run `autopg service install` (Tier B from cutover G20), entries 1+2 disappear from pm2 and live as `autopg.service` (systemd user-unit) instead. Entries 3-5 stay under pm2 either way (Tier B does not absorb them in v2.4).

## Trigger

Live debugging session, 2026-04-30:

1. WhatsApp DM lands at omni-api ✅
2. omni dispatches to NATS ✅
3. **bridge silently dropped — `genie serve` was running in a foreground bash on `/dev/pts/24` and died when the shell closed** ❌
4. Operator (Felipe) sent multiple test messages; nothing came back. Recovery required SSH into the server, kill the orphan, re-launch `genie serve` manually.

Earlier in the same session: omni-api was hardened with pm2 + log rotation as part of `omni-lifecycle-hardening` (archived wish). Genie was supposed to follow but never did. The asymmetry is the root cause of every "the bridge is gone again" incident.

Same session also revealed: **multiple pgserve instances running in parallel** (3 distinct postgres-server.js processes, each on a different port). Every service that wants Postgres spins its own embedded pgserve. No single source of truth for connection strings; data dirs scattered across `~/.omni/data/pgserve/`, `~/.genie/data/pgserve/`, and `/dev/shm/pgserve-*`.

## Scope

### IN

1. **autopg gets `install` + `serve` commands** (CLI binary renamed from pgserve in cohort sibling `autopg-distribution-cutover`):
   - `autopg install` — idempotent pm2 registration of `autopg-server` + `autopg-ui` with hardened defaults (mirror omni's `PM2_HARDENED_DEFAULTS`); writes `~/.autopg/admin.json` with `{ supervisor: "pm2", socketDir, port: 5432, installedAt }`. Refuses if `admin.json.supervisor == "systemd-user"` (operator on Tier B).
   - `autopg serve` — long-lived postmaster wrapper pm2 invokes. Defined in cohort sibling `pgserve-singleton-no-proxy` G1.
   - `autopg status` / `autopg url` / `autopg port` — discovery API for downstream installers. `port` returns 5432 (Unix socket preferred via `autopg url`).
   - `autopg uninstall` — `pm2 delete autopg-server autopg-ui` + leave data dir intact + clear `admin.json.supervisor`.

2. **Hardened pm2 defaults shared.** Extract `PM2_HARDENED_DEFAULTS` and `buildPm2StartArgs` from `omni/packages/cli/src/pm2.ts` into a small shared shape every installer copies. Constants stay duplicated across repos (avoids a new shared package), but the values are pinned in this wish:
   ```
   maxRestarts: 10
   restartDelayMs: 5000
   maxMemoryRestart: 2G (api/serve), 1G (nats)
   killTimeoutMs: 20000
   logDateFormat: YYYY-MM-DD HH:mm:ss.SSS
   logs: ~/.<service>/logs/<name>-{out,error}.log
   ```

3. **`genie install` (NEW).** Mirror of `omni install`:
   - Calls `autopg install` first (no-op when already registered).
   - Reads `autopg url` to get the canonical connection string (Unix socket via `host=$XDG_RUNTIME_DIR/pgserve` or TCP `localhost:5432`).
   - Registers `genie-serve` under pm2 with hardened defaults — refuses if `admin.json.supervisor == "external"` (operator owns supervision; emits remediation).
   - Writes `~/.genie/config.json` with `databaseUrl: <autopg url>`.
   - Idempotent; safe to re-run.
   - Adds `--non-interactive` for CI/install.sh.

4. **`omni install` reconfigured.** Stops embedding pgserve inside `omni-api`'s lifecycle:
   - Calls `autopg install` first.
   - Migration: pg_dump from current `~/.omni/data/pgserve/` → restore into canonical autopg → stop and pm2-delete the embedded pgserve.
   - Update `omni-api`'s `DATABASE_URL` env to point at canonical autopg (Unix socket preferred).
   - Existing `omni doctor` already audits this; extend it to check connection-string-points-at-canonical-autopg.
   - Refuses if `admin.json.supervisor == "external"` (same guardrail as genie install).

5. **`install.sh` updates.** Both repos' bootstrap scripts route through the new pattern:
   - `omni/install.sh`: install autopg@latest → `autopg install` → `omni install`.
   - `genie/install.sh`: install autopg@latest → `autopg install` → `genie install`.

6. **Brain documentation.** Add to genie-configure's brain:
   - `Configuration & Routing/canonical-pgserve-pm2.md` — architecture map: 4 pm2 services, pgserve as central PG, install ordering.
   - `Runbooks/recover-pm2-stack.md` — how to diagnose / restart any of the 4 services; `pm2 resurrect` after reboot.
   - `_decisions/2026-04-30-canonical-pgserve.md` — ADR documenting why one pgserve instead of N embedded.

### OUT

- **No replacement of pgserve with vanilla postgres.** pgserve stays; we only canonicalize how it's deployed.
- **No port migration tooling for third-party consumers.** If someone else's app talks to omni's old pgserve port directly, they update on their own.
- **No automatic uninstall of legacy embedded pgserve data dirs.** Migration copies forward; the old data stays on disk until operator removes it (avoids accidental data loss).
- **No multi-host pgserve cluster.** Single host only. Multi-host pgserve is a separate, much larger wish.
- **No systemd / launchd as the DEFAULT path.** pm2 is the rootless default supervisor that ships with `autopg install` (Tier A). Systemd / launchd ships in the same v2.4 release as `autopg service install` (Tier B, privileged opt-in) — see the singleton-no-proxy wish's two-tier supervisor model. This wish (when it lands) only specifies the pm2 tier.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | autopg owns the install + serve subcommands | Other services should NOT know how to register autopg under pm2 — that's autopg's responsibility. Same pattern as omni owning omni-api/nats. |
| 2 | Idempotent `*-install` everywhere | Every installer can be re-run without harm. Re-running `autopg install` after it's already registered exits 0 with "already installed." Same for `omni install` and `genie install`. |
| 3 | Cross-repo install dependency: autopg → omni & genie | omni and genie shell out to `autopg install` first. They DON'T re-implement autopg registration. Tighter coupling, but simpler than a shared package, and avoids "two installers disagree on hardening defaults." |
| 4 | `--interpreter none` for pm2 launches | Both genie and omni binaries use `#!/usr/bin/env bun` shebangs. `--interpreter bun` triggers pm2's ESM/require crash on top-level await. Shebang resolution side-steps the issue. **Empirically validated 2026-04-30** during the manual genie-serve pm2 registration. |
| 5 | `genie serve start --headless --no-tui --no-interactive` for pm2 | TUI requires a real terminal; pm2 child has no tty. Headless + no-tui matches omni-api's mode. **Empirically validated 2026-04-30.** |
| 6 | Migration via pg_dump + restore (not file-level copy) | Data file format is sensitive to PG version; pg_dump is portable. Even with same autopg version, dump+restore is the safe path. |
| 7 | `~/.autopg/admin.json` is the single contract for supervisor + connection discovery. Schema: `{ supervisor, socketDir, port, installedAt }` with `supervisor ∈ { "pm2" \| "systemd-user" \| "launchd" \| "external" }`. | `autopg install` writes it; `genie install`/`omni install` read it via `autopg url` / `autopg port`; `autopg doctor` reads `supervisor` field to pick the right liveness check. The CLI is the contract. Schema co-owned with cohort sibling `pgserve-singleton-no-proxy` G1. The `external` value is set by `autopg install --no-pm2` when the operator manages supervision externally; downstream `genie install`/`omni install` refuse on `external` (they cannot register their own services without claiming a supervisor). |
| 8 | pm2-logrotate stays as a module, not a pm2 service | It's a pm2 module by design; `omni install` already configures it. `autopg install` reuses the same pm2-logrotate (no duplicate setup). |
| 9 | Downstream installers refuse when `admin.json.supervisor != "pm2"` | If operator has run `autopg service install` (Tier B), `genie install`/`omni install` MUST refuse to add their own pm2 entries (would create double-supervision). Operator runs `autopg service uninstall` first to revert to Tier A. Felipe directive 2026-05-08. |

## Success Criteria

- [ ] `autopg install` registers `autopg-server` + `autopg-ui` as pm2 services with hardened defaults; idempotent on second invocation; writes `~/.autopg/admin.json` with `supervisor: "pm2"`.
- [ ] `autopg url` returns a valid connection string (Unix socket preferred, TCP 5432 fallback) that other tools can use without autopg being CLI-imported.
- [ ] `omni install` on a clean machine results in: `autopg-server` + `autopg-ui` + `omni-api` + `omni-nats` all under pm2 with green status.
- [ ] `genie install` on a clean machine results in: `autopg-server` + `autopg-ui` + `genie-serve` all under pm2 with green status.
- [ ] On a machine where both omni and genie are installed, exactly **5 pm2 services** are present (`autopg-server`, `autopg-ui`, `omni-api`, `omni-nats`, `genie-serve`), autopg is shared, and both `omni doctor` and `genie doctor` are green.
- [ ] On reboot, `pm2 resurrect` brings all 5 services back online with correct env.
- [ ] Existing omni installs migrate without data loss: pre-migration `omni events list` content matches post-migration content.
- [ ] `genie serve` running under pm2 survives shell closure (the bug that triggered this wish stays fixed forever).
- [ ] `omni doctor` and `genie doctor` both gain a check: "process is registered under pm2 with hardened defaults AND `admin.json.supervisor` matches host expectation" (yes/no with one-line remediation if no).
- [ ] Brain entries (architecture map, runbook, ADR) merged in genie-configure.
- [ ] **Tier B refusal**: on a host where operator has run `autopg service install` (admin.json.supervisor == "systemd-user"), running `genie install` or `omni install` exits non-zero with remediation hint `"autopg is on Tier B (systemd-user); run autopg service uninstall to revert to Tier A before installing genie/omni under pm2"`.
- [ ] **Tier B coexistence**: with autopg on Tier B (systemd-user) and omni-api/omni-nats/genie-serve on pm2, `omni doctor` and `genie doctor` both pass when their connection-string check resolves against the systemd-managed autopg.

## Execution Strategy

Wave-based; each wave can ship independently. Three repos, four PRs total.

### Wave 1 — autopg library extraction + uninstall (BLOCKS waves 2 & 3)

**Note**: scope narrowed 2026-05-08 per /review. Cutover wish G11/G19 own the `autopg install` and `autopg serve` binary subcommands. This wish ships ONLY the libraries (pm2-args, admin-json) and the `autopg uninstall` surface that cutover doesn't cover. Genie / omni installers consume cutover's `autopg install` AND this wish's `pm2-args` library directly.

**Goal:** Provide library + uninstall surfaces that downstream installers consume. Cutover wish owns the binary subcommands themselves.

- Group 1.1 — `src/lib/pm2-args.js` + `src/lib/admin-json.js` + `src/commands/uninstall.js` (autopg uninstall). Cutover G11 / G19 own `autopg install` / `serve` / `status` / `url` / `port` (see Group 1 ownership boundary, line 218).
- Group 1.2 — Tests: pm2-args defaults match values pinned in this wish; admin-json writer is atomic; uninstall idempotency round-trip.
- Group 1.3 — README: document `autopg uninstall` subcommand + the cohort `~/.autopg/admin.json` schema.

**Validation:**
```bash
autopg install                    # green; pm2 list shows `autopg-server` + `autopg-ui`
autopg install                    # exits 0, "already installed"
autopg url                        # postgres://localhost:5432/postgres or unix:$XDG_RUNTIME_DIR/pgserve
autopg port                       # 5432
autopg status --json              # { name: "autopg-server", status: "online", port: 5432, supervisor: "pm2", socketDir: "..." }
pm2 list | grep -E '(autopg-server|autopg-ui)'   # both online, max-restarts=10
jq -e '.supervisor == "pm2"' ~/.autopg/admin.json
```

**PR:** `automagik/autopg#???` — `feat(cli): autopg install + pm2 supervision (Tier A)`.

### Wave 2 — `genie install` (depends on Wave 1)

**Goal:** Genie has parity with omni — `genie install` registers `genie-serve` under pm2 by calling `pgserve install` first.

- Group 2.1 — New `genie install` command in `src/genie-commands/install.ts`. Calls `pgserve install`, then `pm2 start` for genie-serve with the hardened args validated in this server's manual test (`--interpreter none` + `serve start --headless --no-tui --no-interactive`).
- Group 2.2 — Update `genie serve start` to detect when genie-serve is already pm2-supervised: print "Already managed by pm2; use `pm2 restart genie-serve`" and exit. Avoid the multi-instance lockfile dance.
- Group 2.3 — `genie doctor` adds `pm2-supervision` check.
- Group 2.4 — Tests for install command (with PM2 stubbed).
- Group 2.5 — `install.sh` updated to call `pgserve install` then `genie install`.

**Validation:**
```bash
genie install                                            # green
pm2 list                                                 # includes autopg-server + autopg-ui + genie-serve
genie doctor                                             # all green; canonical-autopg=ok
genie serve stop && genie install                        # idempotent
# Tier B refusal: autopg service install (sets admin.json.supervisor=systemd-user), then re-run:
genie install                                            # refuses: "autopg is on Tier B; revert with autopg service uninstall first"
# kill the shell that ran install — bridge stays alive (the original incident's reproduction)
```

**PR:** `automagik-dev/genie#???` — `feat(cli): genie install + pm2 supervision`.

### Wave 3 — `omni install` reconfig (depends on Wave 1)

**Goal:** Omni's installer routes through canonical pgserve instead of the embedded one.

- Group 3.1 — `omni install` calls `pgserve install` before `omni-api` registration.
- Group 3.2 — Migration handler: detect existing `~/.omni/data/pgserve/` running under omni-api → pg_dump → restore into canonical pgserve → update omni-api `DATABASE_URL` env → delete embedded pgserve from pm2 → preserve old data dir on disk (operator can `rm -rf` later when satisfied).
- Group 3.3 — `omni doctor` adds `connection-string-canonical` check.
- Group 3.4 — Tests for migration path (start with embedded, run install, verify omni-api connects to canonical).
- Group 3.5 — `install.sh` updated to call `pgserve install` first.

**Validation:**
```bash
# Fresh machine
omni install
pm2 list                            # autopg-server + autopg-ui + omni-api + omni-nats
omni doctor                         # all green; connection-string-canonical=ok

# Existing machine (with embedded pgserve)
omni install                        # detects legacy, runs migration
omni events list --limit 100        # data preserved post-migration
pm2 list                            # autopg-server + autopg-ui + omni-api + omni-nats (no embedded pgserve)
```

**PR:** `automagik-dev/omni#???` — `feat(install): canonical autopg + migration from embedded pgserve`.

### Wave 4 — Brain ingestion (depends on Waves 1–3 merging)

**Goal:** Document the canonical layout so future agents inheriting any of these servers know the pattern by reading a single file.

- Group 4.1 — `brain/Configuration & Routing/canonical-pgserve-pm2.md`: architecture map; 4-service ascii diagram; pgserve discovery via `pgserve url`; install ordering.
- Group 4.2 — `brain/Runbooks/recover-pm2-stack.md`: diagnose/restart any of the 4 services; `pm2 resurrect` after reboot; rollback to embedded pgserve (if migration goes wrong).
- Group 4.3 — `brain/_decisions/2026-04-30-canonical-pgserve.md`: ADR; alternatives considered (vanilla postgres, systemd-user, embedded-everywhere); consequences.

**PR:** `namastexlabs/genie-configure#???` — `chore(brain): canonical autopg + pm2 supervision`.

## Execution Groups

### Group 1: autopg pm2 lifecycle libraries + uninstall (Wave 1)

**Goal:** Provide the **library + uninstall surfaces** that downstream Tier A consumers (genie install, omni install) and the cohort sibling cutover wish Group 11 / Group 19 consume. **Ownership boundary** (locked 2026-05-08 per /review): cutover wish G11 owns `autopg install` (binary subcommand + pm2 register); cutover wish G19 owns `autopg serve` + `status` / `url` / `port` discovery primitives. This wish owns ONLY:
- `src/lib/pm2-args.js` (Tier A hardened defaults — DUPLICATED constants per Decision 3, no shared package)
- `src/lib/admin-json.js` (cohort-shared atomic writer/reader/supervisor-refusal helper, schema co-owned with `pgserve-singleton-no-proxy` G1)
- `src/commands/uninstall.js` (NEW surface — `autopg uninstall` not declared anywhere in cutover wish)

**Deliverables:**
1. `src/lib/pm2-args.js` (NEW) — exports `PM2_HARDENED_DEFAULTS` (maxRestarts=10, restartDelayMs=5000, maxMemoryRestart per service, killTimeoutMs=20000, log paths, `--interpreter none`) + `buildPm2StartArgs(serviceName, opts)`. Constants are duplicated across repos (autopg, genie, omni) per Decision 3 — copying simpler than a shared package. Cutover G11's `autopg install` consumes this module.
2. `src/lib/admin-json.js` (NEW) — atomic writer (writes to `<file>.tmp` + `fs.rename`) + reader + `assertSupervisor(expected: "pm2" | "systemd-user" | "launchd" | "external")` helper that throws with the locked remediation hint when the actual supervisor differs. Schema: `{ supervisor, socketDir, port, installedAt }`. **Co-owned with `pgserve-singleton-no-proxy` G1** — that wish's deliverable 6 references the same file path. This wish guarantees the module exists; singleton wish G1 wires it into postmaster bring-up.
3. `src/commands/uninstall.js` (NEW) — `autopg uninstall`: `pm2 delete autopg-server autopg-ui` + clear `~/.autopg/admin.json.supervisor` (sets to `null` so a subsequent `autopg install` succeeds without the Tier-B refusal trigger) + leave data dir intact + audit-log entry. Idempotent.
4. Tests: `__tests__/pm2-args.test.js`, `__tests__/admin-json.test.js` (atomic-write + supervisor-refusal cases), `__tests__/uninstall.test.js`.

**Out of scope (owned elsewhere):**
- `autopg install` binary subcommand — owned by cutover G11.
- `autopg serve` — owned by cutover G19.
- `autopg status` / `url` / `port` — owned by cutover G19 (the discovery primitives "continue to work unchanged" reading `runtime.json` first).

**Acceptance Criteria:**
- [ ] `src/lib/pm2-args.js` exports `PM2_HARDENED_DEFAULTS` with the exact values pinned in this wish + `buildPm2StartArgs(name, opts)` factory.
- [ ] `src/lib/admin-json.js` writer is atomic (`<file>.tmp` rename pattern) — concurrent writers do not corrupt the file (validated under `__tests__/admin-json.test.js`).
- [ ] `assertSupervisor("pm2")` throws when actual supervisor is `systemd-user` with the locked remediation hint.
- [ ] `autopg uninstall` removes both pm2 entries + clears `admin.json.supervisor` (sets to `null`); idempotent on second invocation.
- [ ] After `autopg uninstall`, a subsequent `autopg install` succeeds (no Tier-B-refusal false positive).

**Validation:**
```bash
bun test test/lib/pm2-args.test.js test/lib/admin-json.test.js test/cli/uninstall.test.js
autopg install && autopg uninstall && autopg install   # idempotent round-trip
```

**depends-on:** none (cross-wish dependency on `pgserve#pgserve-singleton-no-proxy` Group 1 declared in Cross-wish dependencies section)

---

### Group 2: genie install + pm2 supervision (Wave 2)

**Goal:** `genie install` is the rootless symmetric installer for `genie-serve`. Calls `autopg install` first; registers `genie-serve` under pm2; updates `~/.genie/config.json`. `genie doctor` adds `pm2-supervision` + `canonical-autopg` checks.

**Deliverables:**
1. `src/genie-commands/install.ts` — calls `autopg install`; reads `autopg url`; registers `genie-serve` with hardened defaults (`--interpreter none` + `serve start --headless --no-tui --no-interactive`).
2. `src/genie-commands/doctor.ts` — adds `pm2-supervision` and `canonical-autopg` checks.
3. `src/term-commands/serve.ts` — detects pm2 supervision and defers to `pm2 restart genie-serve`.
4. `src/lib/pm2-args.js` — copy from autopg's spec (Decision 3: constants duplicated, no shared package).
5. `install.sh` — route through `autopg install` → `genie install`.
6. Refusal path: `genie install` refuses non-zero when `admin.json.supervisor == "external"` (operator owns supervision).

**Acceptance Criteria:**
- [ ] On a fresh host, `genie install` produces `pm2 list` containing `autopg-server`, `autopg-ui`, `genie-serve`.
- [ ] `genie doctor` is green; `pm2-supervision` and `canonical-autopg` checks pass.
- [ ] `genie serve` running under pm2 survives shell closure (regression test for original incident).
- [ ] `genie install` refuses when `admin.json.supervisor == "external"` with remediation hint.
- [ ] `genie install` refuses non-zero when `admin.json.supervisor == "systemd-user"` with the locked remediation hint `"autopg is on Tier B (systemd-user); run autopg service uninstall to revert to Tier A before installing genie/omni under pm2"` — matches Decision 9 (line 116) + Success Criterion line 130 + cohort sibling `pgserve-singleton-no-proxy` G1 acceptance line 194. The hybrid case (autopg on Tier B; genie under pm2) is reached by the OPPOSITE flow: install everything under Tier A first, THEN run `autopg service install` to migrate ONLY autopg to Tier B (cutover G20's hard MIGRATE contract handles the orderly swap).

**Validation:**
```bash
genie install && genie doctor
pm2 list | grep -q genie-serve
nohup genie install &  # close shell; bridge stays alive
```

**depends-on:** Group 1

**cross-wish depends-on:** `pgserve#autopg-distribution-cutover` Group 11 (autopg install Tier A — provides the binary subcommand this wish's `genie install` shells out to before registering `genie-serve`). Also Group 20 for the Tier-B-refusal acceptance criterion (line 272 — must read `admin.json.supervisor` set by Group 20's MIGRATE flow).

**Implementation history (2026-05-09):** Substantially shipped via `automagik-dev/genie` repo (the wish's PRs #55 + #57). `src/genie-commands/install.ts` self-documents as "Wave 2 of the canonical-pgserve-pm2-supervision wish (PR pgserve#55, Wave 1 = pgserve#57)" and registers the pm2 service as **`Genie`** (capital G), renamed from `genie-serve` at v4.260507.2 — `LEGACY_PM2_PROCESS_NAMES` set + `removeLegacyPm2Entries` drives the in-place migration of operators on the older name. Doctor checks landed under different names than the wish prescribed: `pgserve binary` + `pgserve under pm2` (vs wish-prescribed `pm2-supervision` + `canonical-autopg`); functional intent matches but the literal IDs differ. Decision 3 (`src/lib/pm2-args.js` shared lib duplicated per repo) is **NOT yet landed in genie**: pgserve's `src/lib/pm2-args.js` is canonical but genie has no copy — the constants are likely inlined in genie's install.ts. Tracked as a follow-up gap. Audit trail: `ENGINEER-AUDIT-CANONICAL-G2.md` (7 defects: 1 CRITICAL handoff-drift, 3 HIGH naming + missing pm2-args, 2 MEDIUM unverified deliverables 3/5/6, 1 LOW doc staleness).

---

### Group 3: omni install reconfig + migration (Wave 3)

**Goal:** Omni installer routes through canonical autopg. Migration handler dumps embedded pgserve → restores into autopg → updates omni-api `DATABASE_URL`.

**Deliverables:**
1. `packages/cli/src/commands/install.ts` — calls `autopg install`; removes embedded pgserve registration.
2. `packages/cli/src/lib/migrate-from-embedded-pgserve.ts` — pg_dump from `~/.omni/data/pgserve/` → restore into canonical autopg → pm2-delete embedded pgserve.
3. `packages/cli/src/commands/doctor.ts` — adds `canonical-connection-string` check.
4. `install.sh` — `autopg install` → `omni install`.
5. `--dry-run` migration mode + filesystem snapshot recommendation in docs.

**Acceptance Criteria:**
- [ ] Fresh machine: `omni install` produces `pm2 list` with `autopg-server`, `autopg-ui`, `omni-api`, `omni-nats`.
- [ ] Existing-embedded machine: `omni install` migrates without data loss (`omni events list` content preserved).
- [ ] Post-migration: no embedded pgserve in pm2 list.
- [ ] `omni doctor` `canonical-connection-string` passes; `DATABASE_URL` points at autopg.
- [ ] `omni install` refuses when `admin.json.supervisor == "external"`.
- [ ] `omni install` refuses non-zero when `admin.json.supervisor == "systemd-user"` (matches genie install behavior + Decision 9; same locked remediation hint).

**Validation:**
```bash
bash tests/integration/omni-fresh-install.sh
bash tests/integration/omni-migrate-from-embedded.sh
omni doctor | grep -q "canonical-connection-string: ok"
```

**depends-on:** Group 1

**cross-wish depends-on:** `pgserve#autopg-distribution-cutover` Group 11 (autopg install Tier A — `omni install` shells out to it before registering `omni-api` + `omni-nats`). Also Group 20 for the Tier-B-refusal acceptance criterion (line 302).

**Implementation history (2026-05-09):** Partially shipped via `automagik-dev/omni` repo. `packages/cli/src/lib/canonical-pgserve.ts` exposes `resolveCanonicalPgservePreference` (canonical helper), imported by `packages/cli/src/commands/install.ts`. The migration helper file (deliverable 2) is **not present under the wish-prescribed name** `migrate-from-embedded-pgserve.ts` — actual migration logic location/name is TBD pending deeper audit (may be in `canonical-pgserve.ts` under a different export, or pending implementation). The `canonical-connection-string` doctor check (deliverable 3 + acceptance criterion 4) was **not found by literal grep** of `packages/cli/src/commands/doctor.ts` — either renamed during implementation or still pending. Acceptance criterion 2 ("no data loss") has no defined fixture or comparison script and needs a `tests/integration/omni-migrate-from-embedded.sh` baseline. Audit trail: `ENGINEER-AUDIT-CANONICAL-G3.md` (8 defects: 1 CRITICAL handoff-drift, 3 HIGH file-rename + missing-check + no-fixture, 3 MEDIUM unverified + naming + duplication, 1 LOW doc staleness).

---

### Group 4: Brain ingestion + ADR (Wave 4)

**Goal:** Document the canonical 5-service layout so future agents inheriting these servers know the pattern from a single file.

**Deliverables:**
1. `brain/Configuration & Routing/canonical-autopg-pm2.md` — architecture map; 5-service ascii diagram; autopg discovery via `autopg url`; install ordering; Tier A vs Tier B switching.
2. `brain/Runbooks/recover-pm2-stack.md` — diagnose/restart any of the 5 services; `pm2 resurrect` after reboot; rollback to embedded pgserve (if migration goes wrong); switch from Tier A → Tier B (run `autopg service install`).
3. `brain/_decisions/2026-04-30-canonical-autopg.md` — ADR; alternatives considered (vanilla postgres, systemd-only, embedded-everywhere); consequences.

**Acceptance Criteria:**
- [ ] All three files merged in `namastexlabs/genie-configure`.
- [ ] Architecture map matches the actual end-state pm2 list on a host with all three repos installed.

**Validation:**
```bash
test -f brain/Configuration\ \&\ Routing/canonical-autopg-pm2.md
test -f brain/Runbooks/recover-pm2-stack.md
test -f brain/_decisions/2026-04-30-canonical-autopg.md
```

**depends-on:** Group 1, Group 2, Group 3

**Implementation history (2026-05-09):** Fully shipped via `namastexlabs/genie-configure` repo. All three deliverables landed (verified by clone + `ls`):

- Architecture map: `brain/Configuration & Routing/canonical-pgserve-pm2.md` (230 lines, header `Updated: 2026-05-02` — fresher than original 2026-04-30 design).
- Runbook: `brain/Runbooks/recover-pm2-stack.md` (246 lines, exact filename match).
- ADR: `brain/_decisions/2026-04-30-canonical-pgserve.md` (112 lines; ADR header reads `Status: ACCEPTED — shipped as 3 PRs across namastexlabs/pgserve, automagik-dev/genie, automagik-dev/omni`; references this wish slug + cites the orthogonal `2026-04-30-fingerprint-trust.md` predecessor).

**Filename rename note:** 2 of 3 deliverables ship under `canonical-pgserve-*` rather than the wish-prescribed `canonical-autopg-*` (only `recover-pm2-stack.md` matches exactly). Rename aligns with Decision #7 of the `autopg-distribution-cutover-finalize` wish (`autopg` and `pgserve` are interchangeable bin names). Side effect: the validation block above (`test -f brain/Configuration\ \&\ Routing/canonical-autopg-pm2.md` + `test -f brain/_decisions/2026-04-30-canonical-autopg.md`) currently FAILS against shipped state because the shipped filenames use `pgserve`. A follow-up cleanup should either retarget the test-f paths or document both names as acceptable.

**Scope clarifications:** (1) Acceptance criterion 2 ("Architecture map matches the actual end-state pm2 list") still has no recorded fixture or diff target — verification today is human-eyeballing the 230-line map against `pm2 list` on a canonical-stack host. (2) "Brain ingestion" was fulfilled by human-authored markdown drops in `genie-configure`, NOT by an automated `@khal-os/brain` ingestion pipeline (none observed in the cloned repo). Future contributors should not expect an automation hook here.

Audit trail: `ENGINEER-AUDIT-CANONICAL-G4.md` (5 defects: 1 CRITICAL status-correction, 1 HIGH filename-drift, 2 MEDIUM carryovers from T9, 1 LOW scope-clarification).

---

## Dependencies

```
Wave 1 (autopg)  ──┬──→ Wave 2 (genie)
                    ├──→ Wave 3 (omni)
                    └──→ Wave 4 (brain — also depends on Wave 2 & 3)
```

## Cross-wish dependencies

- **paired-with** `pgserve#autopg-distribution-cutover` — v2.4 cohort sibling. Owns the `pgserve` → `autopg` rename, CDN distribution, and `autopg service install` (Tier B G20). This wish's downstream installers (`genie install`, `omni install`) must read the `~/.autopg/admin.json.supervisor` field this cohort defines, and refuse when the value is not `pm2`.
- **paired-with** `pgserve#pgserve-singleton-no-proxy` — v2.4 cohort sibling. Owns the data-plane refactor (`autopg-server` postmaster, dual-transport, `autopg url`/`port` discovery). Decision 7's `~/.autopg/admin.json` schema is co-owned with that wish's Group 1.
- **builds-on** `omni-lifecycle-hardening` (archived) — established the `PM2_HARDENED_DEFAULTS` shape mirrored here.
- **closes** the operator-lockout footgun the canonical-genie-omni-wiring + omni-host-fingerprint-trust wishes paved over with workarounds.
- **does-not-conflict-with** `aegis-runtime` (separate daemon, separate supervisor).

## QA Criteria

- [ ] On a fresh Ubuntu 24 box: `curl … omni/install.sh | bash` results in 3 pm2 services (pgserve + omni-api + omni-nats), green doctor.
- [ ] On the same box: `curl … genie/install.sh | bash` adds genie-serve = 4 pm2 services. pgserve shared.
- [ ] Reboot the box: `pm2 resurrect` brings all 4 back; both doctors green; bridge subscribes to NATS without manual intervention.
- [ ] Kill any one of the 4 services with SIGKILL: pm2 restarts it within 5 s; doctor goes red briefly then green.
- [ ] On a machine with the OLD embedded pgserve setup: `omni install` (post-Wave-3) migrates without data loss.
- [ ] `pgserve install` followed by `pgserve install --rotate-port 8433` correctly re-registers pgserve on the new port and updates omni-api/genie-serve env (or refuses cleanly if they're using the old port).
- [ ] `omni-host-fingerprint-trust` pipeline (the wish that closed two days before this one) keeps working — instances flagged `requireGenieSignature: true` still get gated correctly post-migration.

## Assumptions / Risks

| # | Item | Risk | Mitigation |
|---|---|---|---|
| 1 | pgserve repo accepts the new install/serve subcommands | Low — author is in the same org | If rejected, fall back to having omni and genie register pgserve directly (loses the "owned by pgserve" property but still gets us to 4 services). |
| 2 | Migration from embedded pgserve preserves all data | Medium — pg_dump on a live system + connection-string switch is non-trivial | Stage in Wave 3 with `--dry-run` first; document rollback. Take filesystem snapshot before running on production. |
| 3 | pm2 ESM/await crash with bun on future bun versions | Low | `--interpreter none` is robust; documented Decision 4. |
| 4 | Operators who customized their existing pgserve port will be confused | Medium | `omni doctor` and `genie doctor` add explicit "this service points at non-canonical pgserve" check with override flag. |
| 5 | NATS port also needs canonicalization (similar split-brain risk) | Out of scope for this wish | Park as a follow-up wish if it becomes a problem. omni-nats is single-instance today via pm2 so no urgency. |
| 6 | genie-configure (this brain) is not in the cycle | None | Wave 4 lands the docs in this repo only; no source code changes here. |

## Files to Create / Modify

### `automagik/autopg` (Wave 1)
- `src/commands/uninstall.js` (new — pm2 delete autopg-server + autopg-ui; clears admin.json.supervisor)
- `src/lib/pm2-args.js` (new — shared pm2 launch builder, mirror of omni's `PM2_HARDENED_DEFAULTS`; consumed by cutover G11)
- `src/lib/admin-json.js` (new — schema co-owned with pgserve-singleton-no-proxy G1; writer + reader + supervisor-refusal helper; consumed by cutover G11 + singleton G1)
- `bin/autopg` (modify — add `uninstall` subcommand routing only; install/serve/status/url/port routing lives in cutover G11/G19)
- `__tests__/pm2-args.test.js`, `__tests__/admin-json.test.js`, `__tests__/uninstall.test.js` (new)
- `README.md` (modify — `autopg uninstall` subcommand + cohort `~/.autopg/admin.json` schema)

**Owned elsewhere (cohort sibling, NOT created by this wish):**
- `src/cli/install.js` — cutover G11
- `src/cli/serve.js` (or equivalent) — cutover G19
- `src/cli/status.js` / `url.js` / `port.js` — cutover G19
- `bin/autopg` install/serve subcommand routing — cutover G11/G19

### `automagik-dev/genie` (Wave 2)
- `src/genie-commands/install.ts` (new)
- `src/genie-commands/doctor.ts` (modify — add pm2-supervision check)
- `src/term-commands/serve.ts` (modify — detect pm2 supervision, defer)
- `install.sh` (modify — route through `pgserve install` + `genie install`)
- `src/lib/pm2-args.js` (new — copy from this wish's spec)
- Tests for install + doctor changes.

### `automagik-dev/omni` (Wave 3)
- `packages/cli/src/commands/install.ts` (modify — call `pgserve install` first; remove embedded pgserve registration)
- `packages/cli/src/lib/migrate-from-embedded-pgserve.ts` (new)
- `packages/cli/src/commands/doctor.ts` (modify — add canonical-connection-string check)
- `install.sh` (modify — `pgserve install` step)
- Tests for migration path.

### `namastexlabs/genie-configure` (Wave 4)
- `brain/Configuration & Routing/canonical-pgserve-pm2.md` (new)
- `brain/Runbooks/recover-pm2-stack.md` (new)
- `brain/_decisions/2026-04-30-canonical-pgserve.md` (new)

## Validated Beachhead (already shipped manually)

The genie-serve part is **already running under pm2** on this server as of 2026-04-30 16:08 UTC. Manual command used:

```bash
pm2 start /home/genie/.bun/bin/genie \
  --name genie-serve \
  --interpreter none \
  --max-restarts 10 \
  --restart-delay 5000 \
  --max-memory-restart 2G \
  --kill-timeout 20000 \
  --log-date-format 'YYYY-MM-DD HH:mm:ss.SSS' \
  --output ~/.genie/logs/genie-serve-out.log \
  --error ~/.genie/logs/genie-serve-error.log \
  -- serve start --headless --no-tui --no-interactive

pm2 save
```

Wave 2 codifies this exact invocation as `genie install`. The args are pinned in Decisions 4 & 5.

## See also

- `omni-lifecycle-hardening` (archived) — established the omni-api pm2 hardening pattern this wish extends.
- `aegis-runtime` (draft) — different daemon, different supervisor (launchd/systemd-user), no conflict.
- `invincible-genie` (draft) — orthogonal: that wish is about `genie serve` self-healing; this wish is about `genie serve` being supervised in the first place. Both can ship independently.
- `pgserve-proxy-resilience` — sets up pgserve to exit cleanly when its child dies (so a supervisor can restart it). This wish is the supervisor side of that contract.
