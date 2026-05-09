# Contributing to pgserve

Welcome. Most of this repo follows the conventions in `README.md`; this file covers the dev-only setup details that operators don't need.

## Cloning + worktrees

`pgserve` development uses git worktrees liberally — agent-driven workflows place per-branch checkouts under `~/.genie/worktrees/pgserve/<branch-name>/`. Either flavor works:

```bash
# Standard clone
git clone https://github.com/namastexlabs/pgserve.git
cd pgserve

# Plain git worktree (used by automation under ~/.genie/worktrees/)
git worktree add ~/.genie/worktrees/pgserve/<branch-name> -b <branch-name> origin/main
cd ~/.genie/worktrees/pgserve/<branch-name>
```

## Installing dependencies

```bash
bun install
```

### Watch out: `bun install` runs the postinstall hook against your real `~/.autopg/data`

`scripts/postinstall.cjs` auto-runs `autopg upgrade --quiet` if it detects an existing `~/.autopg/data/` directory. That's the right behavior for end-users (zero-touch upgrades) but the wrong behavior for contributors — running an upgrade against your dev DB from a half-built worktree can leave it in an unexpected state.

The postinstall hook now auto-skips when the package root sits under `~/.genie/worktrees/` or in a git worktree (detected via the `<root>/.git` file's `gitdir:` pointer). For non-worktree dev checkouts, or to silence the dev-worktree skip notice, use the explicit env-var override:

```bash
AUTOPG_SKIP_POSTINSTALL=1 bun install
```

To fully isolate a `bun install` run from your real config dir (recommended when running tests that need a clean fixture):

```bash
HOME=$(mktemp -d) AUTOPG_SKIP_POSTINSTALL=1 bun install
```

The `HOME` override redirects `~/.autopg`, `~/.pgserve`, and any other home-dir lookups to a throwaway tmp dir for the duration of the install.

## Running tests

```bash
bun test --timeout 30000
bun run lint
bun run deadcode
bun run console:build   # required before tests/console/* runs
```

## Wishes + cohort coordination

Active work tracks via `.genie/wishes/<slug>/WISH.md` and the `genie` CLI. The `pgserve` cohort is currently driving toward v2.6.0 (finalize cohort: groups G1–G5 across the existing `autopg-distribution-cutover-finalize` wish). See `HANDOFF.md` for current state.
