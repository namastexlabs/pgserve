# Wish: autopg upgrade — transparent flush + auto-postinstall

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `autopg-upgrade-command` |
| **Date** | 2026-05-03 |
| **Author** | Felipe Rosa (via felipe agent, dogfooding live break) |
| **Appetite** | small (~1 engineer-day) |
| **Branch** | `wish/autopg-upgrade-command` |
| **Design** | _No brainstorm — direct wish_ |
| **Predecessor** | [autopg-v22 wish](../autopg-v22/WISH.md) (DRAFT — partial ship caused live break) |

## Summary

Add `autopg upgrade` — an idempotent CLI command that transparently migrates an autopg installation across versions (port reconciliation, binary cache flush, plpgsql `.so` re-resolve, env file refresh, consumer reconnect signal). Wire it into the npm postinstall hook so users running `bun add @automagik/autopg@latest` get zero-touch migration. Restores the `autopg ships → consumer transparently picks up next install` contract that broke when autopg-v22's partial roll-out moved binaries to `~/.autopg/`, defaulted PG to port 9432, and stranded plpgsql extension references against the old `$libdir`.

## Scope

### IN

- New CLI verb `autopg upgrade` in `bin/autopg-cli.js` (idempotent, safe to re-run)
- Step 1 — port reconciliation: detect running pgserve on port != 8432 → stop, relaunch on 8432, update `postmaster.pid`
- Step 2 — binary cache flush: verify `~/.autopg/bin/<platform>/postgres` exists and matches `PINNED_PG_VERSION`; if drift, re-download (extends `migrateLegacyBinaryCache` from commit 0075c4f)
- Step 3 — plpgsql extension re-resolve: per DB in data dir, `DROP EXTENSION plpgsql; CREATE EXTENSION plpgsql;` to force fresh `.so` path lookup against current `$libdir`
- Step 4 — app env refresh: regenerate `~/.autopg/<name>.env` URLs with new port; verify SCRAM credential still valid (rotate only if config drift detected)
- Step 5 — consumer reconnect signal: emit a sentinel (touch `~/.autopg/state/upgrade.signal` with timestamp) that consumers (omni-api, genie-serve) can watch via fs.watch and respond with `pm2 restart self`
- Step 6 — health validation: `pg_isready` on 8432 + `LOAD 'plpgsql'` smoke test in each DB; report PASS/FAIL summary
- Default port hardcode change in `bin/postgres-server.js`: 9432 → 8432 (preserves user contract from pgserve@2.1.x where consumers configured 8432)
- Postinstall wire in `package.json`: add `"postinstall": "node scripts/postinstall.cjs"`
- `scripts/postinstall.cjs` implementation: detect upgrade vs fresh install (existence of `~/.autopg/data/`); on upgrade run `node bin/autopg-cli.js upgrade --quiet`; soft-fail (warn + exit 0) so `bun install` never breaks
- Integration tests: fresh install path (no upgrade triggered), upgrade path from synthetic 2.1.3 state (binary in `~/.pgserve/bin/`, port 8432 expected) to 2.2.x, no-op path (already on 8432, no drift)
- CHANGELOG.md entry naming the contract: "users upgrading from pgserve@2.1.3 → autopg@2.2.x get transparent migration via postinstall; manual `autopg upgrade` is the explicit escape hatch"

### OUT

- Implementing `autopg create-app` for omni/genie consumer migration (covered by `autopg-v22` wish; this wish only handles the transparent-upgrade primitive)
- Migration of brain, rlmx, hapvida-eugenia, email consumers (per-app wishes after v2.2 ships)
- Multi-host coordination (single-host UID-trust scope per autopg-v22 D3)
- Web dashboard for upgrade history (deferred)
- Rollback command (`autopg downgrade`) — out of scope; users keep snapshot via `autopg backup` if needed
- Modifying drizzle migrations or app-level schema (autopg upgrade only touches PG-internals + binary paths)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Default port stays 8432 | Felipe directive: "no hardcode that breaks user contract — 8432 as always" |
| 2 | Postinstall auto-runs `autopg upgrade` on detected upgrade | Felipe directive: "next version post script update will run it" — zero-touch UX |
| 3 | Postinstall soft-fails (warn + exit 0) | `bun install` must never break for downstream consumers; explicit `autopg upgrade` is escape hatch |
| 4 | DROP+CREATE plpgsql per DB to re-resolve `.so` | Schema metadata pins absolute path; only DROP/CREATE forces re-lookup against current `$libdir` |
| 5 | Consumer reconnect via fs.watch sentinel | Avoids tight coupling — autopg doesn't know which consumers exist; consumers opt in by watching the signal file |
| 6 | All steps idempotent | `autopg upgrade` safe to re-run any number of times; cron-friendly |

## Success Criteria

- [ ] `autopg upgrade` runs end-to-end on a synthetic pgserve@2.1.3 state and leaves system functional (port 8432, plpgsql working, env files current)
- [ ] `autopg upgrade` is no-op (exit 0, < 1s) on already-upgraded system
- [ ] `bun add @automagik/autopg@latest` triggers postinstall which runs `autopg upgrade --quiet` invisibly
- [ ] `bun install` succeeds even if `autopg upgrade` errors (soft-fail with warning)
- [ ] After upgrade: `pg_isready -p 8432` returns OK in any DB AND `psql -c "LOAD 'plpgsql'"` succeeds in every public DB
- [ ] After upgrade: omni-api (configured for 8432) reconnects without manual `pm2 restart` once consumer-side fs.watch lands
- [ ] CHANGELOG names the upgrade contract explicitly
- [ ] All 3 integration tests pass (fresh install, 2.1.3 → 2.2.x upgrade, no-op)

## Execution Strategy

Single wave, sequential — small enough scope that parallelization adds coordination overhead without shipping speed. Engineer implements all 3 groups, validates locally on dogfood machine (Felipe's box currently reproducing the break), opens PR.

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement `autopg upgrade` CLI verb with all 6 steps |
| 2 | engineer | Wire postinstall hook + soft-fail handling |
| 3 | qa | Integration tests + CHANGELOG entry + lint pass |

---

## Execution Groups

### Group 1: `autopg upgrade` CLI verb implementation
**Goal:** Add idempotent `autopg upgrade` command in `bin/autopg-cli.js` that executes 6-step transparent migration sequence.

**Deliverables:**
1. `bin/autopg-cli.js` — register `upgrade` subcommand with `--quiet` and `--dry-run` flags
2. `src/upgrade/index.js` — orchestrator running steps 1-6 in order with structured logging
3. `src/upgrade/steps/port-reconcile.js` — stop pgserve if not on 8432, relaunch on 8432
4. `src/upgrade/steps/binary-cache-flush.js` — extends existing `migrateLegacyBinaryCache` to verify version + re-download on drift
5. `src/upgrade/steps/plpgsql-resolve.js` — for each user DB, run `DROP EXTENSION plpgsql; CREATE EXTENSION plpgsql;`
6. `src/upgrade/steps/env-refresh.js` — regenerate `~/.autopg/<app>.env` with current port + validate SCRAM
7. `src/upgrade/steps/consumer-signal.js` — write `~/.autopg/state/upgrade.signal` with epoch timestamp
8. `src/upgrade/steps/health-validate.js` — `pg_isready` + per-DB plpgsql smoke test
9. Default port change in `bin/postgres-server.js`: 9432 → 8432

**Acceptance Criteria:**
- [ ] `autopg upgrade --dry-run` prints planned steps without executing
- [ ] `autopg upgrade` exits 0 on already-upgraded system in <1s (idempotent no-op)
- [ ] `autopg upgrade` after synthetic 2.1.3 state migrates to 2.2.x state successfully
- [ ] Each step logs `[step-name] OK|SKIP|FAIL: <detail>` to stderr
- [ ] All 6 steps individually unit-tested

**Validation:**
```bash
cd /home/genie/workspace/repos/pgserve && \
  bun test src/upgrade/ && \
  ./bin/autopg-cli.js upgrade --dry-run
```

**depends-on:** none

### Group 2: Postinstall hook + soft-fail wire
**Goal:** Auto-run `autopg upgrade --quiet` on `bun install` of new autopg version, never breaking install if upgrade fails.

**Deliverables:**
1. `scripts/postinstall.cjs` — detect upgrade (existence of `~/.autopg/data/`); skip on fresh install; invoke `node bin/autopg-cli.js upgrade --quiet` with try/catch
2. `package.json` — add `"postinstall": "node scripts/postinstall.cjs"` script
3. Soft-fail: any error in `autopg upgrade` → log warning to stderr → exit 0 (do not break `bun install`)
4. Skip behavior under env override: `AUTOPG_SKIP_POSTINSTALL=1` → exit 0 immediately (CI / containers / install-only flows)

**Acceptance Criteria:**
- [ ] Fresh install (no `~/.autopg/data/`) → postinstall exits 0 silently, no upgrade attempted
- [ ] Upgrade install (existing `~/.autopg/data/`) → postinstall calls `autopg upgrade --quiet`
- [ ] If `autopg upgrade` fails (non-zero exit) → postinstall logs warning + exits 0 (`bun install` succeeds)
- [ ] `AUTOPG_SKIP_POSTINSTALL=1 bun install` skips invocation entirely

**Validation:**
```bash
cd /home/genie/workspace/repos/pgserve && \
  AUTOPG_SKIP_POSTINSTALL=1 node scripts/postinstall.cjs && echo "skip ok" && \
  rm -rf /tmp/test-autopg && AUTOPG_CONFIG_DIR=/tmp/test-autopg node scripts/postinstall.cjs && echo "fresh ok"
```

**depends-on:** Group 1

### Group 3: Integration tests + CHANGELOG + lint
**Goal:** End-to-end validation that the upgrade contract holds; lock the user-facing promise into CHANGELOG.

**Deliverables:**
1. `__tests__/integration/upgrade-fresh.test.ts` — fresh install path; postinstall no-op; `autopg upgrade` available as command
2. `__tests__/integration/upgrade-from-2.1.3.test.ts` — synthetic 2.1.3 state in temp dir → run `autopg upgrade` → assert post-state matches 2.2.x expectations (port 8432, binary in `~/.autopg/bin/`, plpgsql works)
3. `__tests__/integration/upgrade-noop.test.ts` — already-upgraded state; assert `autopg upgrade` exits 0 in <1s with all steps reporting SKIP
4. `CHANGELOG.md` entry under `## v2.2.x — Transparent Upgrade` with the literal contract sentence: *"Users upgrading from pgserve@2.1.3 to autopg@2.2.x get transparent migration via the postinstall hook. Manual `autopg upgrade` remains as the explicit escape hatch for forced re-runs."*

**Acceptance Criteria:**
- [ ] All 3 integration tests pass via `bun test __tests__/integration/upgrade-*.test.ts`
- [ ] CHANGELOG entry present with exact contract sentence
- [ ] `bun run lint` clean
- [ ] No regression in existing `bun test` suite

**Validation:**
```bash
cd /home/genie/workspace/repos/pgserve && \
  bun test __tests__/integration/upgrade-*.test.ts && \
  bun run lint && \
  grep -F "transparent migration via the postinstall hook" CHANGELOG.md
```

**depends-on:** Group 2

## Dependencies

- **depends-on:** `pgserve/autopg-v22` (DRAFT — needs the rename + binary cache plumbing in place; this wish patches the upgrade hole left by partial v22 ship)
- **blocks:** consumer migration wishes for omni, brain, rlmx, etc. (those wait for stable upgrade primitive)

## QA Criteria

After merge to dev:
1. Felipe's dogfood machine (currently reproducing the break) → `bun add -g @automagik/autopg@latest` → postinstall runs upgrade → `genie agent spawn trace` works again (no plpgsql error)
2. `omni doctor` reports 11/11 OK without manual config edit
3. `pm2 ls` shows pgserve still on port 8432 (not 9432)
4. WhatsApp DM end-to-end test: Felipe sends message → agent responds within turn timeout (no false-stale force-close, validates timestamptz fix from omni#599 plus this upgrade fix together)

## Assumptions / Risks

- **Assumption:** consumers (omni-api, genie-serve) will adopt fs.watch for `~/.autopg/state/upgrade.signal` in a follow-up — until then, manual `pm2 restart` is needed after upgrade. Not a blocker for this wish.
- **Risk:** DROP+CREATE plpgsql is technically destructive (loses user-defined plpgsql functions if any exist outside drizzle migrations). Mitigation: in step 3, gate on `pg_proc.proowner = 10` (postgres) only; skip non-system DBs containing user-owned plpgsql functions and warn operator.
- **Risk:** Synthetic 2.1.3 state for tests is approximate — production may have edge cases not covered. Mitigation: dogfood validation on Felipe's box is the canonical test; integration tests are guard-rail.
- **Risk:** Postinstall running `autopg upgrade` could collide with concurrent pgserve usage. Mitigation: step 1 (port-reconcile) detects running pgserve and uses graceful pg_ctl stop; if can't stop in 30s, soft-fail with operator instruction.
