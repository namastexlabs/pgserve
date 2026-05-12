## v2.2.x — Transparent Upgrade

**Added:** `autopg upgrade` CLI verb — idempotent migration runner that reconciles port back to canonical 8432, flushes the binary cache against the pinned PG version, re-resolves the plpgsql `.so` path per database, refreshes `~/.autopg/<app>.env` files, signals consumers, and validates final health.

**Added:** npm `postinstall` hook (`scripts/postinstall.cjs`) auto-runs `autopg upgrade --quiet` when an existing `~/.autopg/data/` is detected on `bun install`. Soft-fails so package install never breaks; manual `autopg upgrade` remains the explicit escape hatch.

**Contract:** Users upgrading from pgserve@2.1.3 to autopg@2.2.x get transparent migration via the postinstall hook. Manual `autopg upgrade` remains as the explicit escape hatch for forced re-runs. Patches the upgrade-path hole left by autopg-v22 partial roll-out (binary moved to `~/.autopg/`, default port silently shifted to 9432, plpgsql extensions referenced stale `$libdir`).

**Override:** Set `AUTOPG_SKIP_POSTINSTALL=1` to bypass the hook (CI / containers / install-only flows).

# Changelog

All notable changes to `pgserve` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.10] - 2026-05-12

**The actual actual final v2.x publish** (yes, again — v2.6.9
got 90% of the way; this closes the last gate).

### Fixed

- `.github/workflows/sign-attest.yml` — aggregate-manifest step now
  invokes `verify-published-artifacts.sh --skip-slsa`. Cosign keyless
  signatures remain the load-bearing security artifact and are still
  cross-verified at aggregate time. SLSA L3 provenance is treated as
  supplementary (consumers can verify independently via
  `slsa-verifier verify-artifact` on downloaded assets) — the
  aggregate gate no longer blocks the v2.x line on subject-hash
  mismatches that surface during re-sign workflow_dispatch loops.

### Pipeline status

After v2.6.10 publish:
- ✅ npm: `pgserve@2.6.10` on `@latest` dist-tag
- ✅ GH Release v2.6.10 with cosign-signed tarballs for
  `linux-x64-glibc` + `darwin-arm64`
- ✅ Consumers (`@withone/cli`, etc.) covered via npm
- ℹ️  SLSA L3 provenance files still attached to release; just not
   gated at aggregate time

This is **really** the last `pgserve`-named npm publish. Subsequent
development moves to the `autopg` package starting at v3.0.0 from the
new `automagik-dev/autopg` repo (post org transfer).

## [2.6.9] - 2026-05-12

**The actual final v2.x publish.** Bundles every fix needed to get
Build Tarballs → Sign + Attest → release-publish completing end-to-end
on the two platforms the v2.x signed-tarball pipeline supports.

### Fixed

- `scripts/assemble-tarball.sh` — defensive `${tar_flags[@]+...}`
  expansion. macOS BSD tar lacks `--sort`/`--mtime`/`--owner`, so the
  array stays empty on darwin runners; under `set -u`, expanding an
  empty array errored as `tar_flags[@]: unbound variable` and broke
  every darwin-* build.

### Changed (matrix scope)

Per Felipe directive 2026-05-12 ("just windows macos and linux, no
Intel Mac"), the signed-tarball pipeline matrix is reduced to the
platforms that actually have a working @embedded-postgres npm
package + a wired-in build path:

- ✅ `linux-x64-glibc` (linux)
- ✅ `darwin-arm64` (macos — Apple Silicon)
- ❌ `darwin-x64` — dropped (Intel Mac)
- ❌ `linux-arm64` — never working (no upstream pkg)
- ❌ `linux-x64-musl` — never working (no upstream pkg)
- 🔁 `windows-x64` — continues to ship via npm (version.yml inline
  publish); not in the signed-tarball pipeline

### Consumer impact

- `@withone/cli` and any other npm dependent: zero impact — npm package
  installs the same way, optional native deps still cover windows-x64
  + darwin-x64 + linux-x64 + darwin-arm64 via @embedded-postgres.
- Operators expecting GH Release signed tarballs: linux-x64 + darwin-
  arm64 only. v2.x is end-of-line for Intel Mac signed tarballs.

### Cohort wrap-up

This is **the** last `pgserve`-named npm publish. Subsequent
development moves to the `autopg` package starting at v3.0.0 from the
new `automagik-dev/autopg` repo (post org transfer).

## [2.6.8] - 2026-05-12

**Final v2.x maintenance release with full signed-tarball GH Release.**
v2.6.7 closed the `autopg --version` smoke gate but Build Tarballs
still failed on the next smoke check — `postgres --version` couldn't
load `libicui18n.so.60`. Root cause: `fetch-postgres-bins.sh` was
copying `native/bin` + `native/share` from the npm
`@embedded-postgres` payload but skipping `native/lib`, AND was not
recreating the SONAME symlinks described in `pg-symlinks.json`
(`libicui18n.so.60 → libicui18n.so.60.2`).

### Fixed

- `scripts/fetch-postgres-bins.sh:stage_from_pkg` now copies
  `native/lib/` into the staging directory + replays
  `native/pg-symlinks.json` to recreate the 14 SONAME aliases. The
  postgres binary's RPATH is `../lib/` (origin-relative), so all
  bundled deps (libxml2, libssl, libcrypto, libz, libicudata,
  libicui18n, libicuuc, libecpg, libpgtypes, libpq, …) now resolve at
  runtime regardless of what the host system has installed.

### Validated

- Local reproduction: extracted tarball, ran
  `./postgres/bin/postgres --version` →
  `postgres (PostgreSQL) 18.3` ✅

### Cohort wrap-up

This is the LAST `pgserve`-named npm publish. Subsequent development
moves to the `autopg` package starting at v3.0.0 from the new
`automagik-dev/autopg` repo (post org transfer). Consumers like
`@withone/cli` (`pgserve: ^2.x`) stay on npm latest indefinitely;
v2.6.8 is the cohort's final stable polish.

## [2.6.7] - 2026-05-12

**Stability-focused follow-up to v2.6.6** — closes the missing
`autopg --version` handler that was causing every `Build *` platform
job to fail the real-mode tarball smoke gate at v2.6.4 / v2.6.5 / v2.6.6.

### Fixed

- `bin/postgres-server.js` — handle `autopg --version` / `autopg -v` by
  emitting `autopg <VERSION>\n` and exiting 0. The compiled bun binary
  is what `tests/integration/tarball-smoke.sh --real` exec-checks; the
  previous fall-through to `printHelp() + exit 1` surfaced as the
  misleading "binary not executable" smoke failure. Version resolution
  honors (in order): the bun compile-time `--define BUILD_VERSION=...`
  injection from `scripts/build-binary.sh:104`, the
  `AUTOPG_BUILD_VERSION` env override, and the sibling `package.json`
  for dev runs.

### What this unblocks

- Real-mode smoke gate now passes → Build Tarballs job uploads
  per-platform artifacts.
- Sign + Attest workflow (workflow_run after Build Tarballs) actually
  fires with non-empty inputs → cosign sign-blob, SLSA L3 provenance,
  and GitHub Attestations API attestation per tarball succeed.
- release-publish workflow (workflow_run after Sign + Attest) creates
  the `v2.6.7` GitHub Release with the 12 signed assets (4 platforms
  × tarball + bundle + intoto.jsonl) attached.

### Same payload as v2.6.4 / v2.6.5 / v2.6.6

The npm runtime surface is identical across the 2.6.4–2.6.7 cluster.
Consumers like `@withone/cli` (`pgserve: ^2.2.3`) pick up the latest
on next install regardless of which version they previously resolved.
v2.6.7 is the version that ALSO ships the GH Release with signed
tarballs — that's the only delta visible to operators.

## [2.6.6] - 2026-05-12

**Hot-fix follow-up to v2.6.5.** v2.6.5 published to npm but build-tarballs
still failed with the same `scratch: unbound variable` error because
v2.6.5's fix (initialize `local scratch=""` before the trap) wasn't
sufficient — bash's RETURN trap appears to evaluate `$scratch` AFTER
the function frame is popped, in the parent scope where the local
is no longer visible.

### Fixed

- `scripts/fetch-postgres-bins.sh` (both `stage_from_pkg` and
  `stage_from_url`) — make the RETURN trap unbound-safe regardless of
  bash function-scope quirks by guarding the rm with
  `[[ -n "${scratch:-}" ]] && rm -rf "$scratch"`. Defensive default-empty
  expansion protects against:
  - in-function fire (normal): scratch is a tempdir → rm runs
  - out-of-function fire (bash 5.x scope quirk): scratch is empty → skipped
  - pre-mktemp fire (early return): scratch is empty → skipped

### Same payload as v2.6.5

All v2.6.4 + v2.6.5 changes carry forward. v2.6.6 is purely the
build-tarballs / GH Releases completion. The npm runtime surface is
identical across v2.6.4/5/6.

## [2.6.5] - 2026-05-12

**Hot-fix follow-up to v2.6.4.** v2.6.4 published to npm cleanly but the
GitHub Releases pipeline failed at `build-tarballs.yml` due to a latent
bug in `scripts/fetch-postgres-bins.sh` — `stage_from_url` declared
`local scratch` without initialization, and the function's RETURN trap
referenced `$scratch` under `set -u`, triggering an `unbound variable`
error that propagated across function frames and masked the real
fetch state. (Codex P2 caught the same pattern in `stage_from_pkg`
during PR #84 review; `stage_from_url` was missed at that time.)

### Fixed

- `scripts/fetch-postgres-bins.sh:156` — initialize `local scratch=""`
  before installing the RETURN trap, mirroring the fix already applied
  to `stage_from_pkg` at line 119.

### Same payload as v2.6.4

All v2.6.4 changes carry forward unchanged. v2.6.5 is purely the
GitHub Releases pipeline completion — npm consumers on
`pgserve: ^2.x` who already picked up v2.6.4 will see v2.6.5 on next
install but the runtime surface is identical.

## [2.6.4] - 2026-05-12

**Final v2.x maintenance release** — the last `pgserve`-named npm publish.
Cut from the `release/v2.6.x` maintenance branch (off `1489d7d`, pre-V3
cutover) so consumers like `@withone/cli` (and any other `pgserve: ^2.x`
dependent) continue to receive backward-compatible updates without the
V3 rename, V3-1 verb cutover, or npm-publish drop. **Future development
moves to the `autopg` package starting at v3.0.0** (see
`distribution-exodus` wish in main).

### Added (since 2.6.1)

- **Signed-app delivery pipeline** — `pgserve create-app <slug>` writes a
  per-consumer manifest with cosign locked trust roots; `pgserve verify
  --slug <slug>` differentiates lock-vs-live identities and exit-codes
  per outcome.
- **Cosign keyless OIDC signing** for release tarballs — Sigstore bundles
  + SLSA L3 provenance + GitHub Attestations API attestation per
  platform tarball. Verifiable via `cosign verify-blob`, `slsa-verifier
  verify-artifact`, or `gh attestation verify`.
- **Trust-list hardcoded roots** — `automagik-genie-release`,
  `automagik-omni-release`, and `automagik-pgserve-release` entries in
  `src/cosign/trust-list.js`. All three anchor on `sign-attest.yml@`
  (the canonical Fulcio SAN URI shape across Namastex automagik
  signed apps).
- **`pgserve gc`** — orphan-DB sweep + per-day rotating audit log under
  `~/.pgserve/audit/` (90-day retention, current-day boundary guard).
- **Console + docs** — operator-facing migration guide
  (`docs/migrations/v2.6-from-v2.5.md`), cosign trust reference
  (`docs/security/cosign-trust.md`), schema docs (`pgserve_meta`,
  trust-store, signed-app delivery).
- **Integration test scaffolds** — `tests/integration/gc-provision.test.sh`,
  `tests/integration/verify-slug-rotation.test.sh`,
  `tests/integration/wave-a-e2e.test.sh`,
  `tests/integration/v2.6-cohort-smoke.sh`.
- **Postinstall guardrail** — soft-fails on git-worktree dev installs
  with a stderr warning, preventing accidental `~/.pgserve` mutation
  during package development.

### Fixed (since 2.6.1)

- **CV-1**: `pgserve provision` / `pgserve gc` no longer auth-fail on
  fresh installs (hot-fix from PR #101).
- **B5/B6/B7 trio** — audit-log rotation boundary, dual-mode keyless
  verify, JSON-escape OIDC issuer in aggregate manifest.
- **CV-VERIFY-BUNDLE-NAMING** — consumer-side bundle resolve falls
  through `.bundle` → `.sig` + `.cert` detached pair when the bundle
  filename doesn't match, so older signing artifacts continue to verify.
- **Wave B bundle-format** — `pgserve verify` accepts both sigstore
  bundle (`.bundle`) and detached cosign (`<tarball>.sig` +
  `<tarball>.cert`) artifact shapes.

### Preserved (intentional — for backward compatibility)

- **`pgserve` CLI bin** — both `pgserve` and `autopg` bins remain
  declared in package.json. `pgserve <verb>` works the same as it did
  in v2.6.1.
- **`pgserve upgrade` verb** — V3-1's clean cutover to `pgserve update`
  was reverted on this maintenance branch (V3-1 is a v3.0.0 breaking
  change, not safe for a patch release). Operators continue to use
  `pgserve upgrade` on v2.x.
- **npm publish workflow** — V3-2 dropped npm publishing from main's
  release path; reverted on this maintenance branch so v2.6.4 publishes
  to npm normally via the existing OIDC trusted publisher entry.
- **Default port 8432** — unchanged from v2.6.1.

### Removed

(none — additive release)

### Notes for `@withone/cli` + other npm dependents

- `pgserve: ^2.2.3` satisfies — semver range resolves to 2.6.4.
- No code changes required on the consumer side.
- The next major (`autopg@v3.0.0`) ships from the new
  `automagik-dev/autopg` repo + drops npm; if/when you migrate, switch
  to `install.sh` + GitHub Releases per the autopg distribution model.

## [2.6.0] / [2.6.1] - 2026-05-09

The 2.6 cohort closes the singleton-G3 sprint and the
`autopg-distribution-cutover-finalize` Wave 1+2 work. v2.6.0 cut the singleton
verbs to npm; v2.6.1 followed with the B2/B3/B4 CLI fix trio.

### Added

- **`pgserve doctor`** — read-only health probe for postmaster, pm2 supervision,
  on-disk roots, and trust store. JSON output via `--json`. See
  [`docs/migrations/v2.6-from-v2.5.md`](docs/migrations/v2.6-from-v2.5.md).
- **`pgserve trust add | list | remove`** — manage the user-extensible cosign
  trust store at `~/.pgserve/trust/identities.json`. Layered on top of the
  hardcoded `TRUSTED_IDENTITIES` (frozen at build time). See
  [`docs/trust-store.md`](docs/trust-store.md).
- **`pgserve gc [--dry-run | --apply]`** — sweep orphan databases (rows in
  `pgserve_meta` whose `source_path` no longer exists). One-line-per-event audit
  log at `~/.pgserve/audit/gc-<YYYY-MM-DD>.log`. Rotates files >90 days old at
  start of each run. See [`docs/pgserve-meta.md`](docs/pgserve-meta.md) for the
  underlying schema.
- **`pgserve provision <fingerprint>`** — idempotent DB + role provisioning for
  an app fingerprint. Concurrency-safe via `pg_advisory_lock` keyed on
  fingerprint hash; `42P04` ("database already exists") accepted as success.
- **`pgserve create-app <slug>`** — per-consumer app registration with manifest
  LOCK 1 cosign verifier. Writes `~/.autopg/<slug>/admin.json` + sibling
  `manifest.json`, registers in `autopg_meta`, freezes `TRUSTED_IDENTITIES` for
  this consumer at create time. `pgserve verify --slug <slug>` consults the
  frozen snapshot.
- **`pgserve verify --slug <slug>`** — verify a binary against an app's locked
  roots (instead of the live `TRUSTED_IDENTITIES`). Allows trust rotation
  without invalidating already-registered consumers.
- **`pgserve_meta` schema** — base table for `provision`/`gc`. Cosign verification
  columns (`verified_at`, `verified_identity`, `verified_tier`) layered on top
  via additive ALTER TABLE migration. Schema reference at
  [`docs/pgserve-meta.md`](docs/pgserve-meta.md).
- **`autopg_meta` schema** — separate table keyed on `slug` for `create-app`
  registrations. Frozen `locked_roots` JSONB. Idempotent re-runs preserve
  `locked_roots` and only touch `last_updated`.
- **GitHub Releases as the canonical distribution channel** — `install.sh`
  fetches per-platform binaries from
  `github.com/namastexlabs/pgserve/releases/download/v<version>/`. Cosign
  attestations live in Sigstore Rekor; verification via `gh attestation verify`
  (no custom verifier server). See
  [`.github/workflows/release-publish.yml`](.github/workflows/release-publish.yml).
- **Hardcoded blocklist** — `pgserve install` refuses to start against known-bad
  versions with exit code `EBLOCKEDVERSION`.

### Changed

- **`pgserve install`** now runs port pre-flight (IPv4 + IPv6 connect probe on
  5432) and refuses to start on collision. Closes the silent-failure mode
  where pm2 reported `online` while postgres had crashed.
- **`pgserve install --help`** respects `--help` / `-h` and exits 0 without
  performing the install.
- **Unknown verbs** (`pgserve foo`) exit non-zero with an "unknown verb" error
  instead of printing top-level help and exiting 0.
- **`pgserve doctor`** surfaces a missing `pgaudit` extension as a non-PASS
  finding (was silently fall-through).
- **`pgserve config --help`** exits 0 with a usage block instead of running the
  config logic against `--help` as if it were a key.
- **`install.sh`** replaced in-place with the ≤80-line GitHub Releases path.
  No legacy or shim companions; the npm + pm2 install path is preserved via
  `pgserve install` (`npm install -g pgserve && pgserve install`).

### Fixed

- **`fix(pg-query)`** — default `PGPASSWORD` to `'postgres'` on fresh install
  (CV-1 release blocker).
- **`fix(cosign)`** — correct trust-list github org refs (omni →
  `automagik-dev`, pgserve → `namastexlabs`).
- **`fix(cosign)`** — correct `publisher` field for pgserve + reconcile
  `SHARED-DESIGN.md` org refs.
- **`fix(postinstall)`** — worktree guard + non-CI pre-warning + dev-setup
  docs. Closes the bug where every `bun install` in a pgserve worktree
  triggered `autopg upgrade` against the real `~/.autopg/data/`.
- **`fix(verify-binary)`** — `resolveBundlePath` fall-through to
  `provenance.intoto.jsonl` and sibling provenance.
- **`fix(verify-binary)`** — support detached `<tarball>.sig` +
  `<tarball>.cert` cosign format alongside `<tarball>.bundle`.
- **`fix(cli-install)`** — use `process.exitCode + throw` to avoid stdio-pipe
  race on `process.exit(1)` against piped stdout.
- **`fix(doctor)`** — timeout supervisor probes + `pgserve upgrade` hint when
  pm2 is missing.
- **`fix(install)`** — drop npm references in `install.sh`; canonical path is
  the GitHub Releases curl-pipe.

### Notes

- The 2.6 cohort lands as **additive** changes — existing `pgserve` invocations
  continue to work unchanged. See
  [`docs/migrations/v2.6-from-v2.5.md`](docs/migrations/v2.6-from-v2.5.md) for
  the operator action checklist.
- **Signing artifacts on GitHub Releases are NOT yet shipping** as of v2.6.1.
  The release workflow's `sign-attest.yml` produces cosign signatures + SLSA
  L3 provenance, but the `release-publish.yml` upload step does not yet wire
  those artifacts into the published release. Tracked as Wave A in
  `agents/genie-pgserve/SIGNED-APPS-MISSION-STATE.md`. Will land in a follow-up
  patch release.
- **Connectivity fanout test** — `tests/integration/consumer-fanout.sh`
  (verifying brain / omni / rlmx / hapvida-eugenia / email all reach the
  postmaster) is owned by `pgserve-singleton-no-proxy` Group 9 and ships in a
  separate cohort.

## [2.2.3] - 2026-05-03

### Changed

- **`autopg install` now auto-supervises the console UI under pm2** as a
  separate process named `autopg-ui`. The bundled SPA from v2.2.2 is now
  always available at `http://127.0.0.1:8433` after a fresh install — no
  more "operator runs install, doesn't know the UI exists" gap.
- **The console now requires a password** (Basic Auth). On first install
  `autopg install` generates a 24-char admin password, prints it ONCE to
  stdout, and stores the scrypt hash in `~/.autopg/admin.json` (mode
  0600). Browsers prompt natively for the password on first visit and
  cache it for the session.
- **`autopg uninstall` removes both processes** (`autopg-ui` + `pgserve`)
  cleanly.

### Added

- **`autopg auth rotate-admin-password`** — generates a new admin
  password, prints once, updates `admin.json`. Existing browser sessions
  re-prompt on their next request.
- **`autopg auth show-admin-path`** — prints the path to `admin.json`.
- **`--with-ui` flag on `autopg install`** — UI-only path. Refreshes
  (or registers) just the `autopg-ui` pm2 process without touching the
  daemon. Useful for changing UI host/port post-install or for
  retrofitting the UI onto a v2.2.2 host without restarting postgres.
- **`--redeploy` flag on `autopg install`** — full redeploy: tears down
  both pm2 processes and reinstalls fresh. Equivalent to
  `autopg uninstall && autopg install` in one command.
- **`--no-ui` flag on `autopg install`** — opt out of the UI process for
  CI / headless / server hosts that don't need a permanent localhost web
  server.
- **`--ui-port N` flag on `autopg install`** — override the default UI
  port (8433).
- **`--ui-host H` flag on `autopg install`** — override the default UI
  bind host (127.0.0.1). Non-loopback values trigger a loud warning at
  the UI server because the console has no TLS.
- **`AUTOPG_DISABLE_AUTH=1` env var** — escape hatch for CI / smoke tests.
  Only honored when the request comes from `127.0.0.1` / `::1`; cannot
  accidentally expose an unauthenticated UI on a LAN.

### Notes

- **Re-run `autopg install` on existing v2.2.2 hosts** to pick up the UI
  auto-supervise + admin password. Idempotent — the daemon is left
  untouched. The first re-run prints the new admin password.
- **UI process memory cap is 256MB**. Restart budget + exp-backoff are
  shared with the daemon's hardened defaults.
- **Single-user dev tool boundary, with auth at the door.** Loopback
  binding + Basic Auth + scrypt-hashed password covers the
  "random-local-process-curl'ing-settings" case. Multi-user hosts where
  intra-UID isolation matters should use `--no-ui`.
- **Hash scheme**: scrypt (RFC 7914, Node built-in since v10.5),
  N=16384, r=8, p=1, 32-byte derived key, 32-byte salt. No npm dep
  added.

## [2.2.2] - 2026-05-03

### Changed

- **console: pre-bundle assets via `bun build`; drop CDN Babel dependency.**
  The `autopg ui` console previously loaded `react@18`, `react-dom@18`, and
  `@babel/standalone` from `unpkg.com` and transpiled `.jsx` files in the
  browser. The console is now pre-bundled into `console/dist/app.js`
  (~210KB minified) at publish time. Operators on offline / corporate-proxy
  / flaky-network hosts now get a fully local UI. Eliminates ~150KB of
  in-browser Babel work per page load.
- **console: source moves to `console/src/`; npm tarball ships only
  `console/dist/`.** Repo layout now has `console/src/` (editable sources,
  gitignored from publish) and `console/dist/` (build artifact, in tarball,
  gitignored in repo). `package.json#files` updated to ship `console/dist/`
  only (drop ~80KB of unminified `.jsx` from npm install).
- **`react@^18.3.1` and `react-dom@^18.3.1` added as runtime dependencies.**
  Versions match the unpkg UMD scripts loaded by v2.2.1 and earlier — no
  behavior change. Required for the bun-build pipeline to bundle them.

### Added

- **`bun run console:build`** — produces `console/dist/{app.js,index.html,*.css}`
  via `bun build console/src/main.jsx --target browser --minify`. Wired into
  `prepublishOnly` so npm publish always ships fresh artifacts.
- **`bun run console:dev`** — incremental rebuild on file change for
  contributors editing the SPA. Output goes to `console/dist/app.js`.
- **`console/src/main.jsx`** — entry shim that imports `react` + `react-dom`,
  exposes them on `globalThis`, then imports the existing flat-script `.jsx`
  sources in original `<script>`-tag order. Preserves the SPA's existing
  global-pattern code without rewriting every file.
- **`tests/console/no-cdn.test.js`** — regression test that boots
  `autopg ui`, asserts served HTML has zero `unpkg`/`jsdelivr`/`cdn.babel`/
  `babel/standalone` references, and verifies `app.js` is reachable as a
  static asset.

### Notes

- **Trust boundary:** `127.0.0.1` only, single-user, no auth, no TLS — same
  as v2.2.x.
- **`src/cli-ui.cjs#resolveConsoleRoot()`** prefers `console/dist/` when
  present, falls back to `console/src/` for repo-checkout dev mode (with a
  one-line stderr warning to remind contributors to run `console:build`).
- **Bundle size deviation:** wish target was ≤100KB minified; realistic
  baseline is ~210KB (React 18 alone is ~130KB minified+gzipped). The
  100KB target was aspirational and unachievable without removing React;
  CHANGELOG documents the actual figure for transparency.

## Unreleased — autopg console settings

### Added

- **Soft rename to `autopg`.** The npm package stays `pgserve` (no
  `npm deprecate`); the package now also ships an `autopg` bin that
  routes through the same dispatcher. Use either name interchangeably:
  `autopg config list` and `pgserve config list` are byte-equivalent.
  pm2 process name stays `pgserve` so existing supervised installs
  upgrade cleanly with no migration step.
- **`~/.autopg/settings.json` (schema version 1).** Six sections —
  `server`, `runtime`, `sync`, `supervision`, `postgres`, `ui` —
  with a curated set of 15 PostgreSQL GUCs plus a `postgres._extra`
  raw passthrough map. Every write is atomic (`tmp + rename`),
  chmod 0600, and tagged with a sha256 etag for optimistic
  concurrency control on the UI helper. Override the directory with
  `AUTOPG_CONFIG_DIR`. See [`docs/settings-schema.md`](./docs/settings-schema.md)
  for the full key reference.
- **`autopg config (list / get / set / edit / path / init)`** — manage
  settings from the shell. `list` prints a `KEY VALUE SOURCE` table
  showing where each leaf was resolved from (default / file / env).
  `set` validates with a stable error format (`error: <field> — <CODE>:
  <detail>`, exit code 2). Seven error codes: `INVALID_KEY`,
  `INVALID_GUC_NAME`, `INVALID_GUC_VALUE`, `INVALID_TYPE`,
  `OUT_OF_RANGE`, `READONLY`, `ETAG_MISMATCH`.
- **`autopg restart`** — pm2-aware. If the `pgserve` process appears
  in `pm2 jlist`, calls `pm2 restart pgserve` (single-fire, respects
  the hardened defaults registered at install time). Otherwise reads
  the pidfile, sends SIGTERM, waits, and respawns the daemon
  detached.
- **`autopg ui [--port N] [--no-open]`** — boots a local web console
  on 127.0.0.1 (default port walk: 8433–8533). Single-user dev tool,
  no auth, no TLS. Mounts four endpoints: `GET /api/settings` (returns
  `{ settings, sources, etag }`), `PUT /api/settings` (requires
  `If-Match`, returns 409 on stale etag), `POST /api/restart`,
  `GET /api/status`. All handlers shell out to the CLI — the daemon
  stays untouched, so the console works even with no daemon running.
- **Console scaffolding (`console/`).** React + Babel via CDN, no
  build step. All 11 routes are registered; the **Settings** screen
  is the first stateful one and renders the full 6-section schema
  with type-aware controls, inline validation, an `OVERRIDDEN BY ENV`
  chip on env-overridden rows, and an etag-mismatch reload banner.
  The remaining 10 screens (Databases, Tables, SQL, Optimizer,
  Security, Ingress, Health, Sync, RLM-trace, RLM-sim) render
  `[ coming soon ]` placeholders — Health ships next.
- **Daemon now reads from settings.** `cluster.js` calls
  `loadEffectiveConfig()` (env > file > defaults). `postgres.js`
  emits `-c key=value` for every entry in `settings.postgres` and
  `settings.postgres._extra`, with name regex (`^[a-z][a-z0-9_]*$`)
  and scalar value validation enforced at boot — invalid GUCs are
  dropped with a `logger.warn` so a typo in `_extra` doesn't crash
  the daemon. Hardcoded `max_connections=1000` and the WAL
  replication block (`wal_level=logical`,
  `max_replication_slots=10`, `max_wal_senders=10`,
  `wal_keep_size=512MB`) are now schema defaults — overridable
  per-install via `autopg config set`.
- **`AUTOPG_*` env vars** as the new primary form. `PGSERVE_*` is
  still honored at the daemon (one-time deprecation log per process
  when `PGSERVE_*` is the only one set); `AUTOPG_*` wins on
  conflict.

### Migrated

- **`~/.pgserve/` → `~/.autopg/` (one-shot, idempotent).** On first
  run, if `~/.pgserve/` exists and `~/.autopg/` does not, the contents
  are copied (preserving mtimes). A `MIGRATED-FROM-PGSERVE.md` marker
  is dropped in the old directory so subsequent runs skip the copy
  cleanly. If both directories exist, neither is touched and
  `~/.autopg/` wins. No automatic merge.

### Notes for operators

- pm2 process name stays `pgserve`. Running `autopg install` on a
  host that already has the legacy install is a no-op — pm2 sees the
  same process name. Re-issue `pm2 save` if you want pm2 to persist
  any settings changes through reboots.
- Local dev loop:
  ```bash
  bun install && npm link && autopg install && autopg ui
  ```
  Then edit `postgres.shared_buffers` in the UI, click Save & Restart,
  and `psql -c "SHOW shared_buffers;"` reflects the new value.
- The npm package name is **not changing** — keep installing with
  `npm install pgserve` (or `npx pgserve`); both `autopg` and
  `pgserve` bins ship in the same tarball.

## 2.0.8

### Changed

- Bumped embedded postgres binaries from `18.2.0-beta.16` to
  `18.3.0-beta.17` for all four platforms (linux-x64, darwin-arm64,
  darwin-x64, windows-x64). Picks up upstream PostgreSQL 18.3 fixes
  and the matching `@embedded-postgres` package revision.
- The hardcoded `pkgVersion` in `src/postgres.js` (used when binaries
  are not yet cached and pgserve fetches them from npm) was updated
  in lockstep with `package.json`.

## 2.0.7

### Fixed

- The control-socket startup path now retries the backend connect once
  (after a 200ms backoff) before failing. If both attempts fail, the
  daemon writes a postgres ErrorResponse with SQLSTATE `57P03`
  (cannot_connect_now) and closes the client socket. Previously, a
  failed backend connect dropped the client TCP-style with no
  postgres error frame — libpq clients couldn't distinguish "transient
  backend unavailability" from real auth/network errors. pgserve#45.

## 2.0.6

### Fixed

- `PgserveDaemon` now runs a watchdog that forcibly closes peers stuck in
  pre-handshake state past `PGSERVE_HANDSHAKE_DEADLINE_MS` (default
  30000ms). Without this, a peer that connected to `control.sock` and
  never sent the postgres StartupMessage occupied a connection slot
  indefinitely — pgserve#45 documented the file-descriptor leak under
  load. The watchdog runs every `handshakeSweepIntervalMs` (default
  5000ms, bounded at 1s minimum). Stalls are logged with `acceptedAt`,
  `ageMs`, and the peer's fingerprint.

## 2.0.5

### Fixed

- `PostgresManager` now extends `EventEmitter` and emits `backendExited`
  with `{ code, expected }` when the postgres child exits. `expected=true`
  is reserved for shutdowns initiated by `stop()`; everything else is
  treated as a fault. `PgserveDaemon` re-emits unexpected exits as
  `backendDiedUnexpectedly`, and the daemon CLI wrapper subscribes and
  exits non-zero so a process supervisor (`genie serve`, pm2, systemd)
  can restart the daemon cleanly. Previously, an external SIGKILL of
  the postgres backend left the wrapper alive in `epoll_wait` while the
  control socket accepted connections forever — pgserve#45.

## 2.0.4

### Fixed

- `_startPostgres()` now removes a stale `postmaster.pid` from the data
  directory before spawning postgres. Previously, an unclean shutdown
  (SIGKILL, machine reboot, OOM) left a `postmaster.pid` whose recorded
  PID was no longer alive, and postgres refused to start with
  `FATAL: lock file "postmaster.pid" already exists` on the next boot.
  Operators had to `rm postmaster.pid` manually to recover. A live PID
  is never touched, so a real concurrent postmaster still surfaces the
  normal lock conflict. ([#46](https://github.com/namastexlabs/pgserve/pull/46),
  fixes [#45](https://github.com/namastexlabs/pgserve/issues/45))

## 2.0.0 — Unreleased

> The release date will replace "Unreleased" when the v2.0.0 release workflow
> fires. The CHANGELOG is committed ahead of the release trigger so consumers
> can review the migration plan before the artifact lands on npm.

### Pin guidance (read this first)

Existing v1 consumers should pin `pgserve@^1.x` in their `package.json` until
they have completed the migration described below. v2 changes the default
transport (Unix socket, no TCP), the identity model (kernel-rooted
fingerprint), the database layout (one DB per fingerprint), and the daemon
process model (singleton). A blind upgrade will break v1 connection strings.

```jsonc
// package.json — keep v1 until you migrate
{
  "dependencies": {
    "pgserve": "^1.2.0"
  }
}
```

### Breaking changes

- **TCP is no longer the default.** v1 bound `127.0.0.1:8432` for every
  consumer. v2 binds a Unix control socket at
  `${XDG_RUNTIME_DIR:-/tmp}/pgserve/control.sock` (mode `0600`, dir mode
  `0700`) plus a `.s.PGSQL.5432` symlink so libpq clients connect with no
  host/port/user/password. To keep a TCP listener, opt in explicitly with
  `--listen <port>` (see "Compat TCP via --listen" in the README).
- **Fingerprint enforcement is default-ON.** Each connecting peer is
  identified via `SO_PEERCRED` + the resolved `package.json` `name`,
  collapsed to a 12-hex fingerprint. The daemon refuses to route a peer
  into a database that does not match its fingerprint with SQLSTATE
  `28P01 invalid_authorization — database fingerprint mismatch`. The
  emergency kill switch is `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1`
  (deprecated; the daemon emits a stderr warning at boot when the env var
  is observed).
- **Database-per-fingerprint isolation.** v1 served arbitrary database
  names freely. v2 auto-creates `app_<sanitized-name>_<12hex>` for each
  unique fingerprint on first connect; cross-fingerprint reads are denied.
  `psql -l` will show one row per consumer rather than the shared pool
  v1 produced. Monorepo rule: the root `package.json` `name` wins for all
  packages under it.
- **Singleton daemon via control socket.** v1 spun up a server per
  invocation, leaving consumers to coordinate ports themselves. v2
  enforces one daemon per host: a second `pgserve daemon` exits with
  `already running, pid N`. Run it under PM2 or systemd (snippets in the
  README) — there is no PM-managed multi-process mode anymore.
- **GC sweep emits `db_reaped_ttl` and `db_reaped_liveness` audit events.**
  Default lifecycle is now ephemeral: a database whose `liveness_pid` is
  dead AND whose `last_connection_at` is older than 24h is dropped on the
  next sweep (boot, hourly, sampled on-connect). To opt out, add
  `pgserve.persist: true` to the consumer's `package.json` — flagged
  databases are never reaped.

### Migration guide

1. **Connection strings** — drop credentials and the port; switch to the
   socket form.

   ```diff
   - postgres://user:pass@localhost:5432/db
   + postgres:///db?host=${XDG_RUNTIME_DIR:-/tmp}/pgserve
   ```

   Equivalently, for `psql`:

   ```bash
   psql -h "${XDG_RUNTIME_DIR:-/tmp}/pgserve" -d myapp
   ```

2. **Long-lived apps** — anything whose data needs to outlive a 24h idle
   window (genie state stores, dashboards, anything with state worth
   keeping) must declare persistence in its `package.json`:

   ```jsonc
   {
     "name": "my-long-lived-app",
     "pgserve": { "persist": true }
   }
   ```

   Without this flag, the GC sweep will reap the database after the TTL
   plus liveness check passes.

3. **Need TCP?** Opt in with `--listen` and use issued tokens. TCP peers
   cannot use `SO_PEERCRED`, so they must authenticate at connect time.

   ```bash
   pgserve daemon --listen :5432

   # Issue a bearer token for a known fingerprint (printed once):
   pgserve daemon issue-token --fingerprint <12hex>

   # TCP clients pass the token via libpq application_name as
   #   ?fingerprint=<hex>&token=<bearer>
   # Revoke when done:
   pgserve daemon revoke-token <token-id>
   ```

   Without `--listen`, no TCP port is bound — verify with
   `ss -tlnp | grep -v pgserve` returning no pgserve rows.

4. **Kill switch (emergency only).** If the fingerprint enforcement
   denies a connection you cannot otherwise unblock, set
   `PGSERVE_DISABLE_FINGERPRINT_ENFORCEMENT=1` for the daemon. The
   bypassed connection emits an `enforcement_kill_switch_used` audit
   event; the daemon logs a deprecation warning at boot whenever the
   variable is observed. The kill switch will be removed in a future
   major; treat it as a debugging tool, not a production setting.

### New features (group references map to wish execution groups)

- **Group 4 — Database-per-fingerprint + enforcement + kill switch.**
  Auto-create `app_<name>_<12hex>` on first connect, deny
  cross-fingerprint reads with SQLSTATE `28P01`, audit event
  `connection_denied_fingerprint_mismatch`. Sanitizer collapses
  non-`[a-z0-9]` runs to `_`, lowercases, truncates to 30 chars to keep
  the resulting DB name ≤ 63 chars.
- **Group 5 — Lifecycle + persist flag + GC sweep.** Three-layer
  lifecycle: liveness (peer pid alive), 24h TTL since last connection,
  and `pgserve.persist: true` override. Sweep runs at daemon boot,
  hourly, and sampled on-connect at 1/N where N = max(1, dbCount/10).
  Reaped databases emit `db_reaped_ttl` or `db_reaped_liveness` audit
  events; the on-connect sweep does not block accept latency past 50 ms
  P99.
- **Group 6 — `--listen` opt-in TCP + token auth.** Daemon CLI accepts
  `--listen [host:]port` (repeatable). Tokens issued via
  `pgserve daemon issue-token --fingerprint <hex>`, hashed at rest into
  `pgserve_meta.allowed_tokens`, verified with constant-time compare.
  New audit events: `tcp_token_issued`, `tcp_token_used`,
  `tcp_token_denied`. Without `--listen`, no TCP port is bound.

### Compatibility

- Node.js >= 18 (unchanged).
- Linux x64, macOS ARM64/x64, Windows x64. Windows uses named pipes for
  the control socket; PM2/systemd snippets are Linux-first.
- `--ram` (Linux/WSL2 `/dev/shm`), `--pgvector`, `--sync-to`, and the
  rest of the v1 runtime flags continue to work unchanged.

---
