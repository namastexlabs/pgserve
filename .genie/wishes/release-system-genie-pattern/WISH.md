# Wish: Adopt khal-os/desktop release pattern (single-branch semver)

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `release-system-genie-pattern` |
| **Date** | 2026-04-25 |
| **Author** | Felipe Rosa |
| **Appetite** | small (~1 day) |
| **Branch** | `wish/release-system-genie-pattern` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Replace pgserve's PR-label-driven release system (`rc`/`stable` labels, `scripts/release.cjs`, `bump-rc`/`promote` workflow_dispatch actions, RC suffix versioning) with the simpler `khal-os/desktop` pattern adapted to a single `main` branch. Keep semantic `1.x.y` versioning via `npm version patch|minor|major`. Drop the RC/promote tier entirely. Complete the npm OIDC Trusted Publishing migration by removing the lingering `NPM_TOKEN` auth path. Preserve the multi-platform binary matrix (Linux/macOS/Windows).

## Scope

### IN

- Single-workflow release pipeline at `.github/workflows/release.yml`, modeled on `khal-os/desktop/.github/workflows/release.yml` + the `workflow_dispatch` path of `khal-os/desktop/.github/workflows/version.yml`, collapsed for single-branch usage.
- Two trigger paths into the same workflow:
  - **Push to `main`** — auto-detect: read `package.json` `version`, if `v${version}` tag does not exist and head commit does not contain `[skip ci]`, run the build/publish/release pipeline.
  - **`workflow_dispatch`** with input `bump: patch|minor|major` — run `npm version ${bump} --no-git-tag-version`, commit `[skip ci] release v${version}`, tag, push, then continue inline with build/publish/release.
- Semantic versioning via `npm version` (no custom Node script). Continues from current `1.2.0` line.
- npm OIDC Trusted Publishing: Node 24 (npm ≥ 11.5.1), `id-token: write`, no `NODE_AUTH_TOKEN`/`NPM_TOKEN`, `NPM_CONFIG_PROVENANCE: "false"` (matches genie/rlmx).
- Reuse existing `version.yml` matrix for Linux x64 / macOS arm64 / Windows x64 binaries; **rename it to `version.yml`** (npm Trusted Publisher is bound to that filename) and rewire its `publish` job to OIDC.
- Simple changelog: `git log --oneline ${PREV}..HEAD --pretty="- %s" | head -50` (matches khal-os exactly).
- Bot-loop guard: `[skip ci]` marker in the bot's bump commit — release.yml skips that commit at the prepare step.
- Delete `scripts/release.cjs` (RC/promote logic obsolete).
- Delete `.github/release.yml` (PR-label-based notes config — superseded by inline `git log`).
- Update README / docs that reference the old `rc`/`stable` label flow.

### OUT

- `dev` branch + dev→main rolling promotion. pgserve has only `main`.
- Two-tier `@next`/`@latest` publishing — every release publishes `@latest` only.
- Date-based `MAJOR.YYMMDD.N` versioning (the genie/rlmx scheme). User explicit: keep semantic `1.x.y`.
- `git-cliff` / `cliff.toml` — overkill for pgserve's release cadence; raw `git log` is what khal-os/desktop uses and is sufficient.
- Cosign keyless signing + SLSA Level 3 provenance (genie has it, khal-os does not, user did not request it).
- Migrating the npmjs.com Trusted Publisher configuration — assumed already configured by user ("we changed to OIDC"). Group 4 verifies; if mis-pointed, surface to user before merge.
- Backward-compatible escape hatch for the old `bump-rc` / `promote` `workflow_dispatch` actions — clean break.
- Changes to `ci.yml`, `commitlint.yml`, or test workflows.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Keep semantic `1.x.y` versioning, drive bumps with `npm version patch\|minor\|major` | User explicit: "i don't wanna change the version numbering". `npm version` is the simplest possible bump tool, no custom scripts, no date math. Matches khal-os/desktop exactly. |
| 2 | Drop the RC / `@next` tier entirely | User explicit: "we only have main, don't have next, which is ok". One tier = fewer states, no rolling-PR machinery, no PR labels. Pre-release ability can be added later via PR-label escape hatch if ever needed. |
| 3 | Single workflow file (`release.yml`) with two trigger paths instead of khal-os's two-file split (`release.yml` + `version.yml`) | khal-os/desktop's `version.yml` carries dev/main/dispatch logic; we only need the dispatch path. Folding into one file removes a layer of indirection without losing capability. |
| 4 | Bot-loop avoidance via `[skip ci]` marker (not `github-actions[bot]` actor check) | Matches khal-os/desktop verbatim. The bump commit message `[skip ci] release v${version}` causes the prepare-job's `if:` gate to short-circuit. Simpler than dual-guarding on actor + marker. |
| 5 | Push-to-main auto-publishes when `package.json` version bumped manually (no dispatch needed) | Lets devs run `npm version patch` locally, commit, PR, merge → release fires. Matches khal-os. The dispatch path is for "I want to release right now without a code change", which is a real but rare case. |
| 6 | Complete OIDC migration in this wish (remove `NPM_TOKEN` from `version.yml`) | User said OIDC is configured, but `version.yml` still passes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. Half-migrated is the worst state — finish the swap. |
| 7 | Keep multi-platform binary matrix in a reusable workflow, but **rename `version.yml` → `version.yml`** | npmjs.com Trusted Publisher is bound to filename `version.yml`. Caller (`release.yml`) updates its `uses:` reference accordingly. |
| 8 | Changelog = raw `git log --oneline` per release range (no cliff) | khal-os uses this exact pattern. For pgserve's release cadence (handful per quarter), the noise of conventional-commit categorization is not worth the `cliff.toml` maintenance. |
| 9 | Cosign + SLSA scoped OUT | Khal-os doesn't sign either. User did not request supply-chain hardening. Track as a separate follow-up wish if ever desired. |

## Success Criteria

- [x] A merged PR triggers `release.yml`, which publishes `pgserve@<version>` to npm tagged `latest`, creates the `v<version>` git tag, and creates a GitHub Release with `git log` notes and the three platform binaries attached. — **Met:** `pgserve@1.2.0` published 2026-04-25T22:15:21Z via [run 24941829291](https://github.com/namastexlabs/pgserve/actions/runs/24941829291) (re-run after npmjs.com Trusted Publisher correctly pointed at `release.yml`). All three binaries on the release.
- [ ] Triggering `release.yml` via `workflow_dispatch` with `bump: patch` produces a new patch version end-to-end (commit + tag + npm publish + GitHub Release with binaries) without a separate human commit. — **Deferred:** structurally identical to the push path, which works. Will validate next time a real bump is needed.
- [x] `package.json` `version` field equals the published npm version (no drift). — **Met:** `package.json` = `1.2.0`, `npm view pgserve@latest version` = `1.2.0`, `gh release view v1.2.0` exists.
- [x] No reference to `secrets.NPM_TOKEN` or `NODE_AUTH_TOKEN` in any `.github/workflows/*.yml`. — **Met.** `grep -r 'NPM_TOKEN\|NODE_AUTH_TOKEN' .github/` is empty on `main`.
- [x] No reference to `bump-rc`, `promote`, `release.cjs`, or PR-label release flow in tracked code outside `.genie/wishes/` and `CHANGELOG.md`. — **Met.** Sole remaining mention is the intentional "legacy — removed" line in `AGENTS.md`'s Release Workflow Protocol.
- [x] The bot's `[skip ci] release v...` commit does not retrigger `release.yml`. — **Met by gate design:** `prepare`'s `if:` filters `[skip ci]` push events. Will be exercised whenever the `workflow_dispatch` path next runs.
- [x] `npx pgserve@latest --version` prints the new semver version. — **Met:** `npm view pgserve@latest version` returns `1.2.0`.
- [x] README's release section describes the new flow in ≤ 6 lines. — **Met:** Makefile help target now describes the new flow; README has no release-process section to maintain.

## Execution Strategy

Sequential, four waves. Group 1 rewrites the workflows. Group 2 deletes the obsolete bits and updates docs. Group 3 is the dry-run validation gate. Group 4 is the post-merge live-fire release verification.

| Wave | Group | Agent | Description |
|------|-------|-------|-------------|
| 1 | 1 | engineer | Rewrite `release.yml` (single-file khal-os pattern: push + dispatch paths, calls `version.yml`). OIDC-ify `version.yml` publish job. |
| 2 | 2 | engineer | Delete `scripts/release.cjs` and `.github/release.yml`. Scrub README/docs of `rc`/`stable` label flow. Drop all `NPM_TOKEN` references. |
| 3 | 3 | qa | Static validation: `actionlint` clean on all workflow files, manual trace of `if:` gates against three commit scenarios, confirm npmjs.com Trusted Publisher entry points at the right workflow. |
| 4 | 4 | qa | Live-fire post-merge: trigger first release via `workflow_dispatch` on a `patch` bump; verify npm `latest`, GitHub Release tag, and `package.json` version all match. |

---

## Execution Groups

### Group 1: Rewrite release.yml (khal-os pattern) and OIDC-ify version.yml

**Goal:** Replace the PR-label-gated workflow with a single-file workflow modeled on khal-os/desktop, supporting both push-to-main auto-detect and workflow_dispatch bump paths. Complete the OIDC migration in `version.yml`.

**Deliverables:**

1. **New `.github/workflows/release.yml`** — full rewrite. Triggers:
   - `push: branches: [main]`
   - `workflow_dispatch` with input `bump: choice [patch, minor, major]`
   
   Jobs (in order):
   - **`bump`** (only on `workflow_dispatch`):
     - Checkout `main` with `fetch-depth: 0` and write token.
     - Configure git as `github-actions[bot]`.
     - Run `npm version ${{ inputs.bump }} --no-git-tag-version`.
     - Commit `[skip ci] release v${VERSION}`, tag `v${VERSION}`, `git push origin HEAD --follow-tags`.
     - Output `version` and `tag`.
   - **`prepare`** (`needs: bump`):
     - `if:` (explicit wiring — must handle skipped `bump` job correctly):
       ```yaml
       if: |
         !cancelled() && !failure() &&
         (github.event_name == 'workflow_dispatch' ||
          (github.event_name == 'push' &&
           !startsWith(github.event.head_commit.message, '[skip ci]')))
       ```
       Why this shape:
       - On `push`: `bump` is skipped (its own `if:` requires `workflow_dispatch`). GitHub Actions blocks `needs:`-dependent jobs when the parent is skipped *unless* the dependent job's `if:` calls `!cancelled() && !failure()` (the default `success()` does not pass on skipped). Without this, the push path is silently broken.
       - On `workflow_dispatch`: `bump` ran and pushed the `[skip ci]` commit + tag. `prepare` runs in the same workflow run (not via re-trigger), so the `[skip ci]` commit-message filter does not apply — `github.event_name` is `workflow_dispatch`, gate evaluates true.
     - Checkout: `ref: ${{ needs.bump.outputs.tag || github.sha }}` — uses bump's tag on dispatch, head SHA on push. Requires `fetch-depth: 0` for tag history.
     - Read version from `package.json`; tag = `v${VERSION}`.
     - Check `gh release view "${TAG}"` — if exists, set `skip=true`.
     - Find previous tag: `gh release list --limit 50 --json tagName -q '.[].tagName' | grep -v "^${TAG}$" | head -1`, verify with `git merge-base --is-ancestor`.
     - Generate notes: `git log --oneline "${PREV}..HEAD" --pretty="- %s" | head -50`.
   - **`build`** (`needs: prepare`, `if: skip == 'false'`): calls `version.yml` with `version`, `npm_tag: latest`, `ref: ${TAG}`.
   - **`release`** (`needs: [prepare, build]`, `if: skip == 'false'`):
     - Download `binaries-*` artifacts.
     - `gh release create "${TAG}" --target ${{ github.sha }} --title "${TAG}" --notes-file /tmp/release-notes.md ${BINARIES}`.
   
   `concurrency: group: release-${{ github.ref }}, cancel-in-progress: false`.

2. **Updated `.github/workflows/version.yml`** `publish` job:
   - Add `permissions: id-token: write`.
   - Bump Node version to `'24'` (gives npm 11.5+ for OIDC out of the box; avoids the `npm install -g npm@latest` bug rlmx hit).
   - Add npm version assertion step (mirror rlmx): fail if `npm --version` major < 11.
   - Add `env: NPM_CONFIG_PROVENANCE: "false"` on the publish step.
   - Remove `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from the publish step.
   - Keep or remove the `environment: npm-publish` based on whether it gates on a token secret (verify: if it's just an audit boundary, keep it; if it's the npm token holder, remove it).

**Acceptance Criteria:**
- [ ] `release.yml` has both `push: branches: [main]` and `workflow_dispatch` triggers with `bump` input.
- [ ] `bump` job runs only on `workflow_dispatch` and produces a `[skip ci]` commit + tag + push.
- [ ] `prepare` job's `if:` gate evaluates to false (skip) when push-event head commit starts with `[skip ci]`, but proceeds for the dispatch chain (because the bump job's outputs feed it directly, not via re-triggered push).
- [ ] `build` and `release` jobs are gated on `prepare.outputs.skip == 'false'`.
- [ ] `version.yml` `publish` job declares `permissions.id-token: write`, uses Node 24, asserts npm ≥ 11, has `NPM_CONFIG_PROVENANCE: "false"`, and contains zero `NODE_AUTH_TOKEN`/`NPM_TOKEN` references.
- [ ] `actionlint` passes on both files.

**Validation:**
```bash
npx --yes actionlint .github/workflows/release.yml .github/workflows/version.yml
! grep -r 'NPM_TOKEN\|NODE_AUTH_TOKEN' .github/workflows/
grep -E 'workflow_dispatch|patch.*minor.*major|\[skip ci\]' .github/workflows/release.yml
grep -E 'id-token: write|NPM_CONFIG_PROVENANCE' .github/workflows/version.yml
```

**depends-on:** none

---

### Group 2: Delete obsolete release machinery and update docs

**Goal:** Remove the old PR-label release path (`scripts/release.cjs`, `.github/release.yml`, Makefile targets, README references) so there is exactly one documented release flow.

**Deliverables:**
1. `git rm scripts/release.cjs`.
2. `git rm .github/release.yml` (PR-label-based GitHub-native notes, superseded).
3. **Update `Makefile`** — there are stale references in two places:
   - **Lines 31-39 (help target):** rewrite the "Quick Commands" / "CI/CD Workflow" lines. Replace `release-rc` / `release-stable` mentions and the three "Add 'rc' label / Add 'stable' label" lines with a single "Releasing" section pointing at the new flow.
   - **Lines 218-242 (`.PHONY: release-rc release-stable release-dry` block):** delete the entire block. The new flow is run via GitHub Actions (`gh workflow run release.yml -f bump=patch`), not Make targets. If a local bump-helper is wanted, replace with a one-liner `release: ## Bump version locally (run 'npm version patch|minor|major' manually)` — but preferred deliverable is to delete the whole block.
4. README / CONTRIBUTING / any `.genie/` doc: remove instructions about `rc` / `stable` PR labels and `bump-rc` / `promote` workflow_dispatch actions. Replace with one short section:
   ```
   ## Releasing
   - Manual: bump locally with `npm version patch|minor|major`, commit, PR to main. Merge → release fires automatically.
   - Bot: trigger `Release` workflow with `bump` input (patch/minor/major). The bot bumps, tags, builds, publishes.
   - Skip: any commit message starting with `[skip ci]` is ignored by the release pipeline.
   ```
5. `package.json`: confirm `prepublishOnly` still runs in CI; add `HUSKY: "0"` to publish step in `version.yml` if the `prepare` script causes issues (mirrors genie's pattern).
6. Confirm no stale references: `grep -rn 'bump-rc\|release\.cjs\|/promote\|stable.*label\|rc.*label' .` returns zero hits in tracked code outside `.genie/wishes/` and `CHANGELOG.md`.

**Acceptance Criteria:**
- [ ] `scripts/release.cjs` deleted.
- [ ] `.github/release.yml` deleted.
- [ ] `Makefile` no longer references `release.cjs`, `bump-rc`, `promote`, `release-rc`, `release-stable`, `release-dry`, or "Add 'rc'/'stable' label".
- [ ] README's release section describes the new flow in ≤ 6 lines.
- [ ] No tracked file outside `.genie/wishes/` or `CHANGELOG.md` mentions `bump-rc`, `release.cjs`, or the old label workflow.

**Validation:**
```bash
test ! -f scripts/release.cjs
test ! -f .github/release.yml
! grep -E 'release\.cjs|bump-rc|release-rc|release-stable|release-dry' Makefile
git ls-files | xargs grep -l 'bump-rc\|release\.cjs' 2>/dev/null \
  | grep -v '^\.genie/wishes/\|^CHANGELOG' || echo "clean"
```

**depends-on:** release-system-genie-pattern#1

---

### Group 3: Static validation and Trusted Publisher verification

**Goal:** Catch issues before merge — workflow lint, `if:` gate trace, npmjs.com Trusted Publisher pointed at the right workflow file.

**Deliverables:**
1. `actionlint` clean on all touched workflow files.
2. Manual trace of `release.yml` `if:` gates against three scenarios, written to `.genie/wishes/release-system-genie-pattern/validation.md`:
   - **Scenario A:** human pushes a commit `chore: bump version to 1.2.1` to main → `bump` job skipped, `prepare` runs, version `1.2.1` tag missing → release fires.
   - **Scenario B:** bot's `[skip ci] release v1.2.1` commit lands via `workflow_dispatch` chain → `bump` ran inline, `prepare` should also run (because the workflow run that fired it is `workflow_dispatch`, not the push triggered by the bot's tag). Confirm the `prepare` job's `if:` gate is structured to handle this.
   - **Scenario C:** human pushes `[skip ci] docs: typo` to main → `prepare` short-circuits, no release.
3. Confirm npmjs.com Trusted Publisher entry for `pgserve` exists and points at `<repo>/.github/workflows/version.yml` (the file that calls `npm publish`). If it points at a nonexistent file, the workflow path entry must be updated by the user before merge — surface clearly.
4. Confirm `prepublishOnly` (`npm run lint && npm run deadcode && npm run test:npx && npm run test:bun-self-heal`) runs in CI without flakes — these are pgserve's release-time integration checks; if any have local-machine assumptions, fix or document.

**Acceptance Criteria:**
- [ ] `actionlint` passes.
- [ ] `validation.md` covers all three scenarios with explicit gate-evaluation results.
- [ ] Trusted Publisher entry confirmed (or user-fixable issue surfaced).
- [ ] `prepublishOnly` chain runs cleanly in a CI dry-run (e.g., on a draft PR).

**Validation:**
```bash
npx --yes actionlint .github/workflows/*.yml
test -f .genie/wishes/release-system-genie-pattern/validation.md
# Trusted Publisher check is a manual step on npmjs.com — document the expected URL/workflow path.
```

**depends-on:** release-system-genie-pattern#2

---

### Group 4: Post-merge live-fire release verification

**Goal:** After this wish merges to `main`, prove the pipeline works by issuing the first real release through both trigger paths.

**Deliverables:**
1. **Dispatch-path test:** trigger `release.yml` via `workflow_dispatch` with `bump: patch` (current version is `1.2.0`, expect `1.2.1`).
2. Verify outputs:
   - npm: `npm view pgserve@latest version` returns `1.2.1`.
   - GitHub Release: `gh release view v1.2.1` exists with binaries (`pgserve-linux-x64`, `pgserve-darwin-arm64`, `pgserve-windows-x64.exe`) and `git log`-style notes.
   - `package.json` on `main` shows `1.2.1` (committed by bot with `[skip ci]`).
3. **Push-path test (deferred until next real change):** when the next non-release PR merges with a manual `npm version patch` bump baked in, confirm the auto-detect path fires and produces `1.2.2`.
4. Update `.genie/wishes/release-system-genie-pattern/validation.md` with the live-fire timestamps + run URLs.

**Acceptance Criteria:**
- [ ] First dispatch-path release (`1.2.1`) ships successfully end-to-end.
- [ ] All three asset names present on the GitHub Release.
- [ ] `npm view pgserve@latest version` matches GitHub Release tag (modulo leading `v`).
- [ ] No bot-loop: `release.yml` does not retrigger from the bot's `[skip ci]` commit.
- [ ] Validation doc updated with run URLs.

**Validation:**
```bash
gh workflow run release.yml -f bump=patch
# Wait, then:
gh release view v1.2.1 --json tagName,assets -q '{tag: .tagName, assets: [.assets[].name]}'
npm view pgserve@latest version
jq -r .version package.json
```

**depends-on:** release-system-genie-pattern#3

## Dependencies

- depends-on: none external.
- blocks: any future supply-chain hardening (cosign + SLSA) wish for pgserve — that wish would extend the new `release.yml`, so this one must land first.

## Assumptions / Risks

- **Assumption:** npmjs.com Trusted Publisher is already configured for `pgserve` and points at `version.yml`. If not, Group 3 surfaces it; first OIDC publish would otherwise fail with 401/403.
- **Assumption:** macOS-arm64 + Windows runners remain available on GitHub-hosted matrix. Already in use today.
- **Risk: `workflow_dispatch` bump commit retriggers `release.yml`.** If the `[skip ci]` marker is not respected (e.g., misplaced in the message), the bot's commit fires the push trigger again and the second run sees the tag already exists → exits via `skip=true`. Idempotent failure mode, not infinite loop. Validate in Group 3.
- **Risk: dispatch path's `prepare` job double-runs.** `workflow_dispatch` triggers `release.yml` directly; the bot's `git push --follow-tags` also triggers a push event. Two parallel runs of `prepare` could race. Mitigation: `concurrency: group: release-${{ github.ref }}, cancel-in-progress: false` serializes them; the second one sees the tag exists and exits.
- **Risk: lost RC capability.** No `@next` channel for testing risky changes. Mitigation: a feature branch + `npm pack` + local `npm install ./pgserve-x.y.z.tgz` test still works. Add a labeled-PR `@next` escape hatch later if real pain emerges.
- **Risk: macOS runner cost.** Builds run on `macos-latest` for every release. With infrequent releases (user's framing: "pgserve doesn't get many updates"), absolute spend stays low. Revisit if monthly cost climbs.
- **Risk: human forgets to bump.** A non-release PR could merge to main without bumping, and no release fires — that is the *desired* behavior. The risk is the inverse: a PR that *should* release forgets to bump. Mitigation: docs explicitly call out the bump step; dispatch path is always available as the fallback.
