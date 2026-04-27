# Brief from genie-pgserve (parent agent)

Read this AFTER WISH.md. Critical operational context that supersedes parts of the wish.

## CRITICAL — genie wish-parser regression is active

Your CLI version is **4.260426.4**. Both `genie work pgserve-v2` and `genie wish status pgserve-v2` will fail with:

```
❌ Group "N" depends on non-existent group "pgserve-v2#M"
```

**Do not interpret that error as a wish problem.** The wish is well-formed.

**Root cause** (already debugged):
- `automagik-dev/genie` `src/term-commands/dispatch.ts:189-197` — `parseWishGroups` stores group names as bare ids (`"1"`, `"2"`) but does NOT strip the `<slug>#` prefix from depends-on entries.
- Then `src/lib/wish-state.ts:240` — `validateGroupRefs` does `groupNames.has("pgserve-v2#1")` against `{"0".."8"}` and throws.
- Affects EVERY wish using the canonical `<slug>#<n>` depends-on form, including the shipped reference `release-system-genie-pattern`.

**GH issue filed**: https://github.com/automagik-dev/genie/issues/1406
**Fix-wish draft**: `/home/genie/workspace/agents/genie-pgserve/brain/_decisions/genie-parser-fix-wish-draft.md`

## Workaround you must use

Bypass `genie work` orchestration. Dispatch each group manually:

```bash
genie spawn engineer  # or reviewer / fix / qa
```

Then `genie send` a curated prompt to the spawned engineer with this structure (per the /work skill's Context Curation rules — DO NOT just say "read WISH.md"):

```
Execute Group N of wish "pgserve-v2".

Goal: <one sentence from WISH.md>

Deliverables:
1. <copy from WISH.md>
2. <copy from WISH.md>

Acceptance Criteria:
- [ ] <copy from WISH.md>
- [ ] <copy from WISH.md>

Validation:
<copy the bash block from WISH.md>

Depends-on: <human-resolved — group N from this wish, already complete>

Repo: /home/genie/workspace/repos/pgserve
Branch: pgserve-v2 (from wish/pgserve-v2)
Worktree: /home/genie/.genie/worktrees/pgserve/pgserve-v2
```

Track group state via your own scratchpad in this worktree (e.g. `STATUS.md` next to this brief). Mark groups done as engineers report PASS.

## Execution order — start parallel waves NOW

| Wave | Groups | When |
|------|--------|------|
| **0** | Group 0 (dogfooder twin) | Spawn now, runs continuously |
| **1** | Group 1 (control DB + audit infra) | Sequential foundation, spawn now in parallel with Group 0 |
| **2** | Group 2 (daemon) ‖ Group 3 (fingerprint) | After Group 1 ships |
| **3** | Group 4 (per-fp DB enforcement) | After Wave 2 ships |
| **4** | Group 5 (lifecycle/GC) ‖ Group 6 (--listen TCP) | After Group 4 ships |
| **5** | Group 7 (genie consumer migration) | After Wave 4 ships |
| **6** | Group 8 (release prep, ship 2.0.0) | After Group 7 ships |

## Important consumer-repo correction

The canary consumer for Group 7 / Group 0 dogfooder is **`automagik-dev/genie`**, cloned at **`/home/genie/workspace/repos/genie`**. NOT `automagik-genie` (no such repo). NOT `namastexlabs/genie`. The wish has been corrected but your initial mental model may have absorbed the earlier wrong name from the genie team-lead system prompt. Verify with `git -C /home/genie/workspace/repos/genie remote -v` before any consumer-side work.

## Felipe's standing constraints

From `agents/genie-pgserve/AGENTS.md`:
- **Don't restart the running pgserve daemon** at PID 160588 (orphaned but Felipe is using it for the email brain).
- **Don't drop any `brain_*` databases** without Felipe's explicit OK.
- **Don't merge PR #16** in `namastexlabs/pgserve` — it's superseded by this wish (delete schema/role machinery, use database-per-fingerprint).
- **Don't propose substituting pgserve with vanilla Postgres** — pgserve IS the answer.
- **Don't spawn pgserve daemons for testing** — use ephemeral test instances per the wish's test fixtures, never daemon mode in tests.

## Reporting back

Cross-team scope is locked one-way (you → me, not me → you). Report status, blockers, completions to me via:

```bash
genie send '<msg>' --to genie-pgserve --bridge
```

I will relay any course-correction signals from Felipe back to you via this BRIEF file (I'll append a `## Update <timestamp>` section). Re-read this file at the start of each wave.

## Felipe's non-negotiable for this wish

- 1.2.0 is the last non-breaking version on the v1 line; lock it.
- 2.0.0 is THIS wish's target — single breaking cut, not staged.
- The 5 non-genie consumers (brain, omni, rlmx, hapvida-eugenia, email) MUST be advised to pin `pgserve@^1.x` before 2.0.0 ships. Group 8's release prep includes that advisory; do not skip it.

Good hunting.
