# Wish: Canonical pgserve + PM2 supervision across genie/omni/pgserve

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `canonical-pgserve-pm2-supervision` |
| **Date** | 2026-04-30 |
| **Author** | genie-configure |
| **Appetite** | medium-large |
| **Repos touched** | `namastexlabs/pgserve`, `automagik-dev/omni`, `automagik-dev/genie`, `namastexlabs/genie-configure` (brain only) |
| **Design** | _No brainstorm — direct wish from operational pain (live debugging session 2026-04-30)_ |

## Summary

Canonicalize **pgserve as the single, central, pm2-supervised database server** that every service in the stack connects to. Make `genie serve` and `omni-api`/`omni-nats` peer-equal pm2 services that boot under the same hardening, register via their own `*-install` commands, and consume pgserve through its CLI.

**End-state pm2 list:**

```
┌──────────────────────────────────────────┐
│  pm2 supervisor                          │
├──────────────────────────────────────────┤
│  1. pgserve         ← NEW (canonical PG) │
│  2. omni-api        ← existing, reconfig │
│  3. omni-nats       ← existing            │
│  4. genie-serve     ← NEW                 │
│                                           │
│  + pm2-logrotate (module, already there) │
└──────────────────────────────────────────┘
```

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

1. **pgserve gets `install` + `serve` commands.** New subcommands in the pgserve CLI:
   - `pgserve install` — idempotent pm2 registration with hardened defaults (mirror omni's `PM2_HARDENED_DEFAULTS`); creates `~/.pgserve/config.json` with canonical port + data dir.
   - `pgserve serve` — long-lived process pm2 invokes (currently `bin/pgserve-wrapper.cjs daemon`, just renamed for clarity).
   - `pgserve status` / `pgserve url` / `pgserve port` — discovery API for downstream installers.
   - `pgserve uninstall` — `pm2 delete pgserve` + leave data dir intact.

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
   - Calls `pgserve install` first (no-op when already registered).
   - Reads `pgserve url` to get the canonical connection string.
   - Registers `genie-serve` under pm2 with hardened defaults.
   - Writes `~/.genie/config.json` with `databaseUrl: <pgserve url>`.
   - Idempotent; safe to re-run.
   - Adds `--non-interactive` for CI/install.sh.

4. **`omni install` reconfigured.** Stops embedding pgserve inside `omni-api`'s lifecycle:
   - Calls `pgserve install` first.
   - Migration: pg_dump from current `~/.omni/data/pgserve/` → restore into canonical pgserve. Stop and pm2-delete the embedded pgserve.
   - Update `omni-api`'s `DATABASE_URL` env to point at canonical pgserve.
   - Existing `omni doctor` already audits this; extend it to check connection-string-points-at-canonical-pgserve.

5. **`install.sh` updates.** Both repos' bootstrap scripts route through the new pattern:
   - `omni/install.sh`: install pgserve@latest globally → `pgserve install` → `omni install`.
   - `genie/install.sh`: install pgserve@latest globally → `pgserve install` → `genie install`.

6. **Brain documentation.** Add to genie-configure's brain:
   - `Configuration & Routing/canonical-pgserve-pm2.md` — architecture map: 4 pm2 services, pgserve as central PG, install ordering.
   - `Runbooks/recover-pm2-stack.md` — how to diagnose / restart any of the 4 services; `pm2 resurrect` after reboot.
   - `_decisions/2026-04-30-canonical-pgserve.md` — ADR documenting why one pgserve instead of N embedded.

### OUT

- **No replacement of pgserve with vanilla postgres.** pgserve stays; we only canonicalize how it's deployed.
- **No port migration tooling for third-party consumers.** If someone else's app talks to omni's old pgserve port directly, they update on their own.
- **No automatic uninstall of legacy embedded pgserve data dirs.** Migration copies forward; the old data stays on disk until operator removes it (avoids accidental data loss).
- **No multi-host pgserve cluster.** Single host only. Multi-host pgserve is a separate, much larger wish.
- **No systemd / launchd path.** pm2 is the single supervisor for this iteration. Aegis-runtime wish covers a future systemd-user variant.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | pgserve owns the install + serve subcommands | Other services should NOT know how to register pgserve under pm2 — that's pgserve's responsibility. Same pattern as omni owning omni-api/nats. |
| 2 | Idempotent `*-install` everywhere | Every installer can be re-run without harm. Re-running `pgserve install` after it's already registered exits 0 with "already installed." Same for `omni install` and `genie install`. |
| 3 | Cross-repo install dependency: pgserve → omni & genie | omni and genie shell out to `pgserve install` first. They DON'T re-implement pgserve registration. Tighter coupling, but simpler than a shared package, and avoids "two installers disagree on hardening defaults." |
| 4 | `--interpreter none` for pm2 launches | Both genie and omni binaries use `#!/usr/bin/env bun` shebangs. `--interpreter bun` triggers pm2's ESM/require crash on top-level await. Shebang resolution side-steps the issue. **Empirically validated 2026-04-30** during the manual genie-serve pm2 registration. |
| 5 | `genie serve start --headless --no-tui --no-interactive` for pm2 | TUI requires a real terminal; pm2 child has no tty. Headless + no-tui matches omni-api's mode. **Empirically validated 2026-04-30.** |
| 6 | Migration via pg_dump + restore (not file-level copy) | Data file format is sensitive to PG version; pg_dump is portable. Even with same pgserve version, dump+restore is the safe path. |
| 7 | Single config file per service, no shared "canonical config" file | `pgserve install` writes `~/.pgserve/config.json`; consumers read it via `pgserve url`. We don't introduce a `~/.canonical/` directory or similar. The CLI is the contract. |
| 8 | pm2-logrotate stays as a module, not a pm2 service | It's a pm2 module by design; `omni install` already configures it. `pgserve install` reuses the same pm2-logrotate (no duplicate setup). |

## Success Criteria

- [ ] `pgserve install` registers `pgserve` as a pm2 service with hardened defaults; idempotent on second invocation.
- [ ] `pgserve url` returns a valid connection string that other tools can use without pgserve being CLI-imported.
- [ ] `omni install` on a clean machine results in: `pgserve` + `omni-api` + `omni-nats` all under pm2 with green status.
- [ ] `genie install` on a clean machine results in: `pgserve` + `genie-serve` all under pm2 with green status.
- [ ] On a machine where both omni and genie are installed, exactly **4 pm2 services** are present (pgserve, omni-api, omni-nats, genie-serve), pgserve is shared, and both `omni doctor` and `genie doctor` are green.
- [ ] On reboot, `pm2 resurrect` brings all 4 services back online with correct env.
- [ ] Existing omni installs migrate without data loss: pre-migration `omni events list` content matches post-migration content.
- [ ] `genie serve` running under pm2 survives shell closure (the bug that triggered this wish stays fixed forever).
- [ ] `omni doctor` and `genie doctor` both gain a check: "process is registered under pm2 with hardened defaults" (yes/no with one-line remediation if no).
- [ ] Brain entries (architecture map, runbook, ADR) merged in genie-configure.

## Execution Strategy

Wave-based; each wave can ship independently. Three repos, four PRs total.

### Wave 1 — `pgserve` foundation (BLOCKS waves 2 & 3)

**Goal:** pgserve owns its pm2 lifecycle.

- Group 1.1 — `pgserve install` + `pgserve serve` + `pgserve status` + `pgserve url` + `pgserve port`. Add `--non-interactive` for CI/install.sh. New file: `src/commands/install.ts` (mirror omni's structure).
- Group 1.2 — Tests: install idempotency, status reflects pm2 state, url/port match what install registered.
- Group 1.3 — README: document the 4 new subcommands.

**Validation:**
```bash
bunx pgserve install              # green; pm2 list shows `pgserve`
bunx pgserve install              # exits 0, "already installed"
bunx pgserve url                  # postgres://localhost:8432/postgres
bunx pgserve status --json        # { name: "pgserve", status: "online", port: 8432, dataDir: "..." }
pm2 list | grep pgserve           # online, max-restarts=10, etc.
```

**PR:** `namastexlabs/pgserve#???` — `feat(cli): pgserve install + pm2 supervision`.

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
pm2 list                                                 # includes pgserve + genie-serve
genie doctor                                             # all green
genie serve stop && genie install                        # idempotent
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
pm2 list                            # pgserve + omni-api + omni-nats
omni doctor                         # all green; connection-string-canonical=ok

# Existing machine (with embedded pgserve)
omni install                        # detects legacy, runs migration
omni events list --limit 100        # data preserved post-migration
pm2 list                            # pgserve + omni-api + omni-nats (no embedded pgserve)
```

**PR:** `automagik-dev/omni#???` — `feat(install): canonical pgserve + migration from embedded`.

### Wave 4 — Brain ingestion (depends on Waves 1–3 merging)

**Goal:** Document the canonical layout so future agents inheriting any of these servers know the pattern by reading a single file.

- Group 4.1 — `brain/Configuration & Routing/canonical-pgserve-pm2.md`: architecture map; 4-service ascii diagram; pgserve discovery via `pgserve url`; install ordering.
- Group 4.2 — `brain/Runbooks/recover-pm2-stack.md`: diagnose/restart any of the 4 services; `pm2 resurrect` after reboot; rollback to embedded pgserve (if migration goes wrong).
- Group 4.3 — `brain/_decisions/2026-04-30-canonical-pgserve.md`: ADR; alternatives considered (vanilla postgres, systemd-user, embedded-everywhere); consequences.

**PR:** `namastexlabs/genie-configure#???` — `chore(brain): canonical pgserve + pm2 supervision`.

## Dependencies

```
Wave 1 (pgserve)  ──┬──→ Wave 2 (genie)
                     ├──→ Wave 3 (omni)
                     └──→ Wave 4 (brain — also depends on Wave 2 & 3)
```

Cross-wish: closes the operator-lockout footgun the canonical-genie-omni-wiring + omni-host-fingerprint-trust wishes paved over with workarounds. Doesn't conflict with `aegis-runtime` (separate daemon, separate supervisor).

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

### `namastexlabs/pgserve` (Wave 1)
- `src/commands/install.ts` (new)
- `src/commands/serve.ts` (new — likely a thin wrapper around the existing wrapper)
- `src/commands/status.ts`, `src/commands/url.ts`, `src/commands/port.ts` (new)
- `src/lib/pm2-args.ts` (new — shared pm2 launch builder, mirror of omni's)
- `bin/pgserve-wrapper.cjs` (modify — add subcommand routing)
- `__tests__/install.test.ts`, `__tests__/url.test.ts` (new)
- `README.md` (modify)

### `automagik-dev/genie` (Wave 2)
- `src/genie-commands/install.ts` (new)
- `src/genie-commands/doctor.ts` (modify — add pm2-supervision check)
- `src/term-commands/serve.ts` (modify — detect pm2 supervision, defer)
- `install.sh` (modify — route through `pgserve install` + `genie install`)
- `src/lib/pm2-args.ts` (new — copy from this wish's spec)
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
