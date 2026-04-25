# Validation: release-system-genie-pattern

Static-validation evidence for Group 3.

## YAML syntax

Both workflow files parse cleanly via `bun + yaml@latest`:

```
.github/workflows/release.yml: parse OK (5 top-level keys)
.github/workflows/version.yml: parse OK (4 top-level keys)
```

`actionlint` is not installed in this sandbox; YAML parse + manual semantic
trace below cover the same ground for the gate logic that's load-bearing.

## Gate trace — `release.yml` `prepare` job

The `prepare` job's `if:` is the single most error-prone piece of the rewrite.
Its declared shape:

```yaml
needs: bump
if: |
  !cancelled() && !failure() &&
  (github.event_name == 'workflow_dispatch' ||
   (github.event_name == 'push' &&
    !startsWith(github.event.head_commit.message, '[skip ci]')))
```

The `bump` job has its own `if: github.event_name == 'workflow_dispatch'`.

### Scenario A — human pushes a `chore: bump version to 1.2.1` commit to main

| Step | Evaluation | Outcome |
|------|------------|---------|
| `bump` `if:` | `github.event_name == 'workflow_dispatch'` is **false** (event is `push`) | `bump` skipped |
| `prepare` `if:` clause 1 | `!cancelled() && !failure()` is **true** (skipped is neither) | continue |
| `prepare` `if:` clause 2 | `event_name == 'workflow_dispatch'` is **false**; OR-branch falls to push clause | continue |
| `prepare` `if:` clause 3 | `event_name == 'push' && !startsWith(head_commit.message, '[skip ci]')` is **true** | enter |
| `prepare` body | reads `package.json` → `1.2.1`; checks `gh release view v1.2.1` → not found | `skip=false` |
| `build` + `release` | `needs.prepare.outputs.skip == 'false'` | run |

**Result:** release fires. ✓

### Scenario B — operator triggers `release.yml` via `workflow_dispatch` with `bump: patch`

| Step | Evaluation | Outcome |
|------|------------|---------|
| `bump` `if:` | event is `workflow_dispatch` | run |
| `bump` body | `npm version patch` → `1.2.1`; commit `[skip ci] release v1.2.1`; tag `v1.2.1`; `git push origin HEAD --follow-tags` | outputs `tag=v1.2.1`, push completes |
| `prepare` `if:` clause 1 | `!cancelled() && !failure()` is **true** (`bump` succeeded) | continue |
| `prepare` `if:` clause 2 | `event_name == 'workflow_dispatch'` is **true**; short-circuits the `[skip ci]` check entirely | enter |
| `prepare` body | checks out at `needs.bump.outputs.tag` (`v1.2.1`); reads `package.json` → `1.2.1`; tag check finds no `v1.2.1` release yet | `skip=false` |
| `build` + `release` | run | publishes + creates GitHub Release |

**Concurrent push run** (the `git push` from `bump` triggers a separate `push` event on `main`):

| Step | Evaluation | Outcome |
|------|------------|---------|
| Concurrency | `release-${{ github.ref }}` matches the in-flight dispatch run; `cancel-in-progress: false` | queues until dispatch completes |
| When dispatch completes | the queued push run starts | continue |
| `bump` `if:` | event is `push` | skipped |
| `prepare` `if:` clause 3 | `head_commit.message` is `[skip ci] release v1.2.1` → `startsWith(..., '[skip ci]')` is **true** → negation **false** | gate **fails** |
| `prepare` job | skipped via `if:` | clean exit |
| Downstream jobs | `build`/`release` `needs: prepare` with `if: skip == 'false'`; `prepare` was skipped, not succeeded — `skip` output is empty string, not `'false'`, so dependents are also skipped | clean exit |

**Result:** dispatch run releases; queued push run no-ops. No bot loop. ✓

### Scenario C — human pushes `[skip ci] docs: typo` to main

| Step | Evaluation | Outcome |
|------|------------|---------|
| `bump` `if:` | event is `push` | skipped |
| `prepare` `if:` clause 3 | `head_commit.message` starts with `[skip ci]` → `!startsWith(...)` is **false** | gate **fails** |
| `prepare` job | skipped | no release |
| `build` / `release` | dependent on `prepare` with `if: skip == 'false'`; output is empty since `prepare` did not run | both skipped |

**Result:** docs-only push does not release. ✓

## OIDC migration check

```
$ grep -r 'NPM_TOKEN\|NODE_AUTH_TOKEN' .github/workflows/
(no matches)
```

```
$ grep -E 'id-token: write|node-version: .24.|NPM_CONFIG_PROVENANCE' .github/workflows/version.yml
      id-token: write
          node-version: '24'
          # npm auto-enables provenance in any CI env with `id-token: write`,
          NPM_CONFIG_PROVENANCE: "false"
```

`version.yml` `publish` job has:
- `permissions.id-token: write` (OIDC token mint)
- Node 24 (ships npm ≥ 11.5.1 with built-in OIDC trusted-publisher)
- Explicit npm version assertion step (fails the run if npm major < 11)
- `NPM_CONFIG_PROVENANCE: "false"` to avoid the 422 sigstore failure
- `HUSKY: "0"` to skip git-hook setup during publish
- No `NODE_AUTH_TOKEN` / `NPM_TOKEN` references

## Trusted Publisher binding

The npmjs.com Trusted Publisher entry for `pgserve` must list:

| Field | Value |
|-------|-------|
| Publisher | GitHub Actions |
| Organization or user | `namastexlabs` |
| Repository | `pgserve` |
| Workflow filename | `version.yml` |
| Environment name | `npm-publish` (matches `environment: npm-publish` on the publish job) |

`build-all-platforms.yml` was renamed to `version.yml` specifically to bind to
this entry. The `release.yml` orchestrator's `uses:` reference was updated to
`./.github/workflows/version.yml` accordingly.

## Stale-reference scan

```
$ git ls-files | xargs grep -l 'bump-rc\|release\.cjs\|release-rc\b\|release-stable\b\|release-dry\b' \
    | grep -v '^\.genie/wishes/\|^CHANGELOG\|^\.genie/code/agents/git/workflows/release\.md'
AGENTS.md
```

The single remaining `AGENTS.md` hit is the intentional "legacy — removed"
documentation line in the rewritten Release Workflow Protocol. It documents
that the legacy system is gone, so future agents have explicit notice.

`.genie/code/agents/git/workflows/release.md` was excluded because it is genie-
framework scaffolding describing the **genie** repo's release workflow, not
pgserve's. It is out of scope for this wish.

## prepublishOnly chain

The `prepublishOnly` chain in `package.json` runs:

```
npm run lint && npm run deadcode && npm run test:npx && npm run test:bun-self-heal
```

The version.yml `publish` job has `bun install` and `oven-sh/setup-bun@v2`
before invoking `npm publish`, so:
- `lint` (eslint) — runs against `src/` + `bin/` ✓
- `deadcode` (knip) — same ✓
- `test:npx` — `npm pack` + isolated install + `npx pgserve` startup at port
  15432. Needs `@embedded-postgres/linux-x64` from optionalDependencies (Linux
  runner pulls correct binary). ✓
- `test:bun-self-heal` — synthetic broken-install fixture, runs wrapper, asserts
  recovery. Needs bun on PATH. ✓ (`oven-sh/setup-bun@v2` provides it)

## Group 3 status

| Criterion | Status | Evidence |
|-----------|--------|----------|
| YAML parses cleanly | ✓ | bun + yaml@latest |
| Gate trace covers 3 scenarios | ✓ | Scenarios A/B/C above |
| Trusted Publisher target documented | ✓ | binding table above; user confirmed `version.yml` filename mid-execution |
| `prepublishOnly` viable in CI | ✓ | bun + Node 24 + Linux runner has all deps |

## Group 4 (live-fire) — push-path validation, evidence

The push-to-main path was exercised end-to-end on 2026-04-25. The release
pipeline required five hotfix iterations after the initial wish landed —
each one peeled a layer that wasn't visible at plan time. Documented here
for posterity so the next time someone touches this, they don't repeat
the same archaeology.

### Hotfix journey

| PR | What it fixed | Symptom |
|----|---------------|---------|
| [#31](https://github.com/namastexlabs/pgserve/pull/31) | Added `id-token: write` to `release.yml` top-level permissions | `startup_failure` in 1s — caller permissions cannot be less than called workflow's |
| [#32](https://github.com/namastexlabs/pgserve/pull/32) | Switched gate to `!= 'true'`, added `Debug resolved outputs` step | Build/release silently skipped despite `prepare.outputs.skip='false'` |
| [#33](https://github.com/namastexlabs/pgserve/pull/33) | Bulletproof gate: `always() && needs.prepare.result == 'success' && needs.prepare.outputs.skip != 'true'` | Debug step proved outputs were correct; reusable-workflow caller's `if:` evaluator was treating `needs.X.outputs.Y` as null when the transitive `needs:` chain included a skipped job |
| [#34](https://github.com/namastexlabs/pgserve/pull/34) | Surface `ref` via `prepare.outputs.ref`, checkout by SHA on push path | Build job ran, then died at checkout trying to fetch `v1.2.0` tag that nobody had created (push path doesn't run `bump`) |
| [#35](https://github.com/namastexlabs/pgserve/pull/35) | Removed `environment: npm-publish` from `version.yml` publish job | Narrowed the OIDC claim mismatch to the workflow filename |
| (npmjs.com) | Trusted Publisher entry: `version.yml` → `release.yml` | npm checks the `workflow_ref` claim (top-level workflow), not `job_workflow_ref` (the reusable). Configure Trusted Publisher with the **caller** filename. |

### Final evidence

| Check | Result |
|-------|--------|
| Workflow run | [24941829291](https://github.com/namastexlabs/pgserve/actions/runs/24941829291) — completed: success after re-run of failed publish |
| All jobs | `Prepare release` ✓ · `Build linux-x64` ✓ · `Build darwin-arm64` ✓ · `Build windows-x64` ✓ · `Publish to npm` ✓ · `Create GitHub Release` ✓ |
| npm | `npm view pgserve@latest version` → `1.2.0` |
| GitHub Release | `gh release view v1.2.0` exists, created 2026-04-25T22:15:21Z, three platform binaries attached |
| `package.json` | `1.2.0` on `main`, matches npm `latest` and the release tag (no drift) |
| Bot-loop guard | Verified by gate-trace design (Scenarios A/B/C above). The `[skip ci]` bot commit is filtered by `prepare`'s `if:`. Will be exercised in practice on the next `workflow_dispatch` bump. |

### Key takeaways for future maintainers

1. **OIDC permissions are caller-bound.** A reusable workflow's `permissions:` request must be subset-matched by what the calling workflow's job has been granted. If you call a reusable that needs `id-token: write`, the caller (workflow-level or job-level) must also declare it. The error mode is `startup_failure` in ~1s.
2. **`needs.<X>.outputs.<Y>` is unreliable in reusable-workflow caller `if:` when the transitive `needs:` chain contains a skipped job.** Use `always() && needs.<X>.result == 'success' && ...` instead of relying on outputs propagation. The empirical evidence is in PR #33's commit body.
3. **Reusable workflow callers cannot reference upstream-of-upstream needs.** If `prepare needs: bump` and `build needs: prepare`, then `build` cannot reference `needs.bump.outputs.*` directly. Surface needed values through intermediate jobs' `outputs:` (see PR #34's `prepare.outputs.ref`).
4. **npm Trusted Publishing matches against `workflow_ref` (the top-level workflow that initiated the run), not `job_workflow_ref` (the file containing the publish job).** Configure the Trusted Publisher entry on npmjs.com with the **caller's** filename. For pgserve: `release.yml`, not `version.yml`.

### Group 4 dispatch path — deferred

`workflow_dispatch` with `bump: patch|minor|major` is structurally identical
to the push path that just succeeded (same `prepare`/`build`/`release`
chain after the `bump` job runs). Not exercised in production yet.
Validate inline next time a real version bump is needed.
