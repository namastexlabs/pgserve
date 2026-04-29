# DESIGN — pgserve v2 (consolidated from genie-pgserve agent brain)

| Field | Value |
|-------|-------|
| **Status** | CRYSTALLIZED |
| **Origin** | Council v2 deliberation (`conv-bf3e8657`, 2026-04-26) — total convergence in Round 2 |
| **Source agent** | `genie-pgserve` (`/home/genie/workspace/agents/genie-pgserve`) |
| **Source docs** | `brain/_decisions/pgserve-roadmap-design.md` + `brain/_decisions/pgserve-roadmap-open-questions-resolved.md` |
| **Council members** | questioner, architect, simplifier, ergonomist |
| **Slug** | `pgserve-v2` |

## Problem

pgserve = "Neon for AI agents" — embedded Postgres-as-a-service for Node.js apps. Tagline: "npx pgserve and it just works, no credentials needed." `postgres/postgres` superuser is intentional product DNA.

Production usage growing across 6 Namastex apps (brain, omni, rlmx, genie, hapvida-eugenia, email). Pain points:

1. Each app spawns its own pgserve → port conflicts.
2. 240+ orphaned test DBs accumulated (no ownership, no GC) — caught a 2,130 errors/sec outage on 2026-04-24 (PR #24 fix).
3. No isolation — any app can see any other app's data (shared superuser by design).
4. PR #16 attempted schema-per-name + role-per-tenant + deny-by-default — rejected because consumer-owns-naming felt wrong.

## Goal

Cut pgserve **v2.0.0** — breaking semver bump (deliberately violating the original "we do not break userspace" plan). Replace v1's per-app TCP spawn + shared-superuser-without-isolation with a portless, fingerprinted, kernel-rooted, lifecycle-managed model. Use `automagik-dev/genie` as the canary consumer (dogfood loop) to validate the design empirically before broader migration.

The original design (`pgserve-roadmap-design.md`) staged this evolution v1.0 → v2.0 across 5 ABI-compatible releases. Felipe's direction on 2026-04-26 collapsed this into a single v2.0.0 cut, accepting the breakage cost in exchange for shorter cycle time and aligning the breaking semver with the actual breaking change.

## Approach

### 1. Transport — portless by default

- Singleton daemon binds well-known control socket at `$XDG_RUNTIME_DIR/pgserve/control.sock` (fallback `/tmp/pgserve/control.sock` for hosts without XDG_RUNTIME_DIR).
- Per-pid sockets remain for direct-embed callers (preserve PR #24 invariants — `_stopping` flag, exit-handler reset, router fallback-on-missing-socket).
- TCP only behind `--listen :PORT` opt-in (k8s pods, remote sync).
- **Kills port conflicts forever** — no ports to conflict over by default.

### 2. Identity — kernel-rooted, package.json-keyed

**Tuple:** `(realpath(nearest-ancestor-package.json), name field, uid)` → `sha256(...).slice(0, 12)`.

Mechanism:
1. SO_PEERCRED on Unix socket → unforgeable `(pid, uid, gid)` from kernel.
2. pgserve walks up `/proc/$pid/cwd` to find nearest `package.json`.
3. Hash the tuple → 12 hex char fingerprint.
4. **Fallback** for scripts with no package.json: `(uid, sha256(cwd + cmdline[1]).slice(0, 12))`.

Why NOT others considered:
- ❌ `sha256(/proc/$pid/exe)` — every Node app resolves to `/usr/local/bin/node`, collision.
- ❌ `cmdline` — mutable (pm2/tsx/nodemon rewrite).
- ❌ `cwd` alone — different cwd in same project = different DBs (wrong).
- ✅ `package.json` realpath — stable across npm install, runtime swap (node→bun), git pull, sub-cd.

### 3. Tenancy — database-per-fingerprint (NOT schema-per)

Schema-per is "isolation theater" under shared superuser — `SET search_path` to anything, fully-qualified SELECTs across schemas, `pg_catalog` enumeration.

Database-per wins because:
- DROP DATABASE atomic → GC trivial (one statement).
- pg_dump per-app works as-is (backup boundary = isolation boundary).
- App still sees `postgres://postgres:postgres@.../app-db` with full superuser inside its DB → magic preserved.
- Cross-DB requires re-auth → proxy routes back → mechanical isolation, not policy.

Database name format: `app_<sanitized-name>_<12hex>`.

### 4. Lifecycle — 3-layer composition

| Layer | Mechanism |
|-------|-----------|
| Default | Ephemeral — auto-DROP when liveness signal lost AND TTL elapsed. |
| Liveness signal | `kill -0 $pid` or `stat /proc/$pid` — owner died starts TTL. |
| Grace window | TTL 24h since last connection — restart with same fingerprint reclaims its DB. |
| Override | `package.json: "pgserve": {"persist": true}` — disables both, durable until explicit drop. |

Composition: test DBs vanish minutes after exit, agent runs vanish 24h after last activity, production knowledge stores never vanish. Zero cron config-side, 240-orphan disease cures itself.

### 5. GC sweep — three composed triggers

| Trigger | When |
|---------|------|
| Opportunistic | Every new connection acquired through control socket (sample 1/N to avoid herd). |
| Periodic | Hourly daemon timer. |
| Boot | Daemon startup (catches orphans accumulated while daemon was down). |

All three call one `gcSweep()` function — no cron config, no consumer involvement.

### 6. Audit log — tiered

| Tier | Destination | Default | Introduced |
|------|-------------|---------|------------|
| 1 | `~/.pgserve/audit.log` (JSONL, rotating 50MB × 5) | ON | v2.0 |
| 2 | Local syslog (`pgserve.audit.target: "syslog"`) | OFF | v2.0 |
| 3 | HTTP webhook (`pgserve.audit.target: "url"`) | OFF | v2.1 |

Schema: `{ts, event, fingerprint, db, peer_uid, peer_pid, package_realpath, ...event_specific}`.

Events: `db_created`, `db_reaped_ttl`, `db_reaped_liveness`, `db_persist_honored`, `connection_routed`, `connection_denied_fingerprint_mismatch`, `enforcement_kill_switch_used`.

### 7. Enforcement — default-on with kill switch

- Default-ON in v2.0.
- `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` environment variable bypasses enforcement (panic kill switch for ops emergencies).
- Marked deprecated; removal slated for v3.0.

### 8. Monorepo behavior

Walk up from `/proc/$pid/cwd` to first `package.json` (deepest match wins). Matches Node's `require.resolve` semantics.

Edge case: `npm workspaces` runs from repo root → all members share root fingerprint → all share one DB. Documented; if isolation needed, run member directly: `cd packages/foo && bun run start`.

Future escape hatch (deferred): `pgserve.fingerprintRoot: "monorepo-root"` in package.json. Build only when demand surfaces.

### 9. Control schema — `pgserve_meta`

Lives in pgserve's own admin DB (separate from user DBs):

```sql
CREATE TABLE pgserve_meta (
  database_name      TEXT PRIMARY KEY,
  fingerprint        TEXT NOT NULL,           -- 12 hex
  peer_uid           INTEGER NOT NULL,
  package_realpath   TEXT,                    -- NULL for script fallback
  created_at         TIMESTAMPTZ DEFAULT now(),
  last_connection_at TIMESTAMPTZ DEFAULT now(),
  liveness_pid       INTEGER,                 -- last known owner pid
  persist            BOOLEAN DEFAULT false
);
```

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Single v2.0.0 cut, not staged | Felipe 2026-04-26: bundle the breaking changes under one semver-major. Cycle time over compat. |
| 2 | Portless default + Unix socket | Eliminates port conflicts (THE #1 embedded-server failure mode) + enables SO_PEERCRED for kernel-rooted identity. |
| 3 | package.json as identity key | Stable across npm install, runtime swap, git pull. npm already mandates it for unrelated reasons. |
| 4 | Database-per-fingerprint over schema-per | Real mechanical isolation vs theater under shared superuser; atomic GC; tool compat (pg_dump, drizzle, prisma). |
| 5 | Fingerprint hash truncated to 12 hex (48-bit) | Birthday-bound at ~16M projects. Postgres ident limit (63) leaves room for `app_<sanitized-name>_<12hex>`. |
| 6 | GC: opportunistic + hourly + boot, single sweep function | Bounds worst-case orphan lifetime ≤ 1h on idle hosts; immediate on active hosts. |
| 7 | Enforcement default-ON with `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` kill switch | Simplifier wins happy path; architect keeps emergency valve. |
| 8 | Monorepo: nearest-ancestor package.json wins | Matches Node `require.resolve`; familiar mental model. |
| 9 | Audit log tiered (file → syslog → webhook) | Zero-config promise honored at tier 1; ops opt into separate sink. |
| 10 | Dogfood `automagik-dev/genie` consumer in lockstep | Provides empirical safety net for the breaking cut; first canary before brain/omni/rlmx/eugenia/email migrate. |
| 11 | DELETE PR #16 schema/role machinery | Replaced by database boundary + peer-creds routing — fewer lines AND honest isolation. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| 5 other consumer apps (brain, omni, rlmx, hapvida-eugenia, email) break on v2.0 install | High | Pin v1.x in their package.json until per-app migration wishes ship. Document upgrade path in v2.0 release notes. |
| package.json walk fails on edge cases (worktree without root, monorepos) | Medium | Fallback to script-mode hash; document monorepo behavior; defer escape hatch until demanded. |
| Production knowledge store loses data on missed `persist: true` flag | High | Errors-that-teach: "Database for `myapp` was reaped — to survive long gaps, set `persist:true`. See pgserve.dev/persist". Pre-flight warning at 90% of TTL. |
| Daemon mode = single point of failure for whole machine | Low | pgserve daemon supervised (PM2/systemd); restart fast; existing apps already tolerated pgserve restarts (per-app spawn). |
| Existing 240 orphans contain sensitive data (PII from hapvida-eugenia, etc) | Medium | One-time inventory + classification BEFORE GC sweep on prod hosts. Separate ops task (out of this wish). |
| Genie consumer migration reveals design flaw mid-build | Medium | Dogfood twin reports daily; if blocking flaw surfaces, pause wish, reconvene council, possibly revert to staged plan. |
| PR #24's stale-socketDir invariants regress in daemon work | High | Wave 2 group must regression-test the three scenarios from #24 (stop nulls socketDir, double-start no-op, exit-handler resets state). |

## What was considered and rejected

- Use vanilla Postgres + 50-line script — pgserve IS the answer; vanilla lacks npx-magic embed.
- Per-app credentials in `.env` — leak via git/Slack/CI logs.
- Schema-per-fingerprint with search_path — isolation theater under shared superuser.
- Pure binary_hash fingerprint — Node apps all resolve to `/usr/local/bin/node`.
- Pure cwd fingerprint — different cwd in same project = different DBs.
- Consumer-supplied naming (PR #16) — pushes ownership to consumer, recreates naming problem.
- TTL-only lifecycle (24h universal) — risks "production data vanished after long weekend".
- ps-aux-only liveness — production knowledge store on host that crashes for 25h would lose data invisibly.
- ABI-compatible 5-stage rollout (`pgserve-roadmap-design.md` original plan) — superseded by Felipe's 2026-04-26 call to bundle as v2.0.

## Open follow-ups (not blockers for this wish)

- One-time inventory + classification of existing 240 orphans on prod hosts (separate ops task).
- Migration wishes for the 5 non-genie consumers (one per app: brain, omni, rlmx, hapvida-eugenia, email).
- Future: cross-host coordination, encryption-at-rest, TLS, multi-tenant role permissions.
