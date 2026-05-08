# DREAM — pgserve v2.4 cohort batch execution

**Date**: 2026-05-08
**Initiated by**: Felipe (genie-pgserve agent dispatch)
**Pre-flight**: /wish refinement + /review SHIP verdict + lint clean — all done.

## Cohort

Three peer wishes shipping pgserve v2.4 together. Separate branches, separate PRs, separate /dream slots per Felipe directive 2026-05-08.

| merge_order | slug | branch | wish_path | depends_on |
|-------------|------|--------|-----------|------------|
| 1 | `pgserve-singleton-no-proxy` | `wish/pgserve-singleton-no-proxy` | `.genie/wishes/pgserve-singleton-no-proxy/WISH.md` | (foundation — no internal deps; cross-wish: none) |
| 2 | `autopg-distribution-cutover` | `wish/autopg-cutover-transport-absorb` | `.genie/wishes/autopg-distribution-cutover/WISH.md` | cross-wish: `pgserve-singleton-no-proxy` G1 (G11/G19/G20 only) |
| 3 | `canonical-pgserve-pm2-supervision` | `wish/canonical-pgserve-pm2-supervision` | `.genie/wishes/canonical-pgserve-pm2-supervision/WISH.md` | cross-wish: `autopg-distribution-cutover` G11 + G20 (G2/G3 only) |

## Execution layers

```
Layer 1 (foundation)
└─ singleton G1 (postmaster -k -p 5432, dual-transport, admin.json writer module src/lib/admin-json.js)

Layer 2 (parallel after L1; cutover G1-G10 are independent of singleton, so could go earlier — but keep linear for human-readable progress)
├─ singleton G2-G9 (delete bun proxy, CLI verbs, cosign primitives, blocklist, self-healing update, roles+grants, migration tooling, tests/docs)
├─ cutover G1-G10 (admin SCRAM, pg_hba B1, schema rename, delete proxy modules, autopg create-app, audit, bun-build binaries, cosign sign, CDN publish, install.sh)
│   NOTE: 11 of these are ALREADY WIP'd on the cutover branch (commits c72dab8 → 7e04f7b). Engineer must read existing commits and only implement what's missing.
└─ canonical G1 (libraries: pm2-args.js + admin-json.js + uninstall.js)

Layer 3 (depends on L2)
├─ cutover G11 (autopg install Tier A — pm2 register, depends on singleton G1's admin.json writer)
├─ cutover G19 (autopg serve dual-transport binding + runtime.json discovery)
└─ cutover G20 (autopg service install Tier B — systemd-user/launchd, hard MIGRATE contract)

Layer 4 (depends on L3)
├─ cutover G12 (autopg update 13-stage pipeline)
├─ canonical G2 (genie install + pm2 supervision; cross-wish dep on cutover G11+G20)
└─ canonical G3 (omni install reconfig + migration; cross-wish dep on cutover G11+G20)

Layer 5 (depends on L4)
├─ cutover G13 (Genie consumer migration — DATABASE_URL from autopg.env)
├─ cutover G14 (Omni consumer migration + release pipelines)
├─ cutover G15 (Final pgserve@2.260503.0 npm advisory)
└─ canonical G4 (Brain ingestion + ADR)

Layer 6 (final)
├─ cutover G16 (Documentation + migration guide unified)
├─ cutover G17 (SHARED-DESIGN.md byte-equality CI lint)
└─ cutover G18 (Cutover validation — Felipe-host + doctor 11/11 + sentinel signoff)
```

## Critical execution constraints

1. **Cutover wish has 11/18 groups WIP'd already.** Engineer must `git log --oneline wish/autopg-cutover-transport-absorb` first; any group whose subject matches `wip: autopg-distribution-cutover#N` is DONE — verify acceptance criteria, do NOT re-implement. New code goes only on G11.6, G12-G18, G19, G20.

2. **Cohort contract files are co-owned.** `src/lib/admin-json.js` + `src/lib/pm2-args.js` ship from the wish that lands first in the merge order. Singleton G1 owns the postmaster; canonical G1 owns the library extraction; cutover G11 owns the binary subcommand. The branches MUST coordinate via the depends-on graph, not race.

3. **--system mode is OUT OF SCOPE.** The parked wish `autopg-service-install-system` is for next-version /dream. If any worker tries to implement `--system` here, it's scope creep — refuse it.

4. **No parallel writes to ~/.autopg/admin.json.** It's a single-host config file. Tier A install (cutover G11) is mutually exclusive with Tier B install (cutover G20). Tests must use isolated `XDG_CONFIG_HOME` fixtures.

5. **Cohort signal: `~/.autopg/admin.json.supervisor` field**. Schema enum: `"pm2" | "systemd-user" | "launchd" | "external"`. Any worker writing this field must use the writer module from singleton G1, not roll their own.

## Phases

| Phase | Action | Trigger |
|-------|--------|---------|
| 1 | Dispatch engineers per wish via `genie work <slug>#<group>`. Layer 1 first; subsequent layers as deps clear. | DREAM.md confirmed (Felipe said "go") |
| 2 | Per-PR `/review` against wish acceptance criteria; fix loops max 2 per PR. | All Phase 1 workers reported DONE |
| 3 | Merge PRs to `main` in `merge_order`. Spawn QA agent on `main`. QA loop until cohort acceptance criteria proven. | All Phase 2 PRs marked SHIP |
| 4 | Write `.genie/DREAM-REPORT.md`. Disband team. | QA verified or blocked-with-reason |

## Branch strategy

- Each wish on its own branch (already pushed).
- Engineer commits ride existing branch; new commits on top.
- PRs target `main` (NOT `dev` — pgserve repo uses single-branch semver per `release-system-genie-pattern`).
- Merge order: singleton → cutover → canonical (per depends-on graph).

## Wake-up artifact

`.genie/DREAM-REPORT.md` will be written when the run completes (success, partial-block, or full-block). Felipe reads that single file on resume.
