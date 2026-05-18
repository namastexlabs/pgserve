## v3.0.1 — build-tarballs fix

**Fixed:** `scripts/fetch-postgres-bins.sh` RETURN trap leaked globally (no `set -o functrace`) and aborted every per-platform build under `set -u` (`scratch: unbound variable`). This blocked the v3.0.0 build chain entirely; v3.0.1 is the first published v3 release (v3.0.0 tag never produced assets).

## v3.0.0 — autopg (org transfer + bootstrap repair)

**Changed:** Repository transferred `namastexlabs/pgserve` → `automagik-dev/autopg` (transfer + rename). Old URLs 301-redirect. `src/cosign/trust-list.js` self-trust regex flipped to `automagik-dev/autopg` — v3+ binaries verify v3+ releases signed under the new org identity.

**Fixed:** `install.sh` fresh-host bootstrap, broken independent of the transfer: correct `autopg-*` asset names with glibc/musl detection, `gh api` latest-resolution (the unauthenticated `curl|sed` path returned empty), correct extracted layout (`autopg/autopg`) plus a `~/.local/bin/autopg` symlink, and a `cosign verify-blob` fallback with a dual-org identity regexp so hosts on `gh < 2.49` can still cryptographically verify the current `latest` (signed pre-transfer under the old org).

**Note:** the npm `pgserve` package remains on v2.6.10 as legacy LTS for `@withone/cli` — not deprecated.

## v2.2.x — Transparent Upgrade

**Added:** `autopg upgrade` CLI verb — idempotent migration runner that reconciles port back to canonical 8432, flushes the binary cache against the pinned PG version, re-resolves the plpgsql `.so` path per database, refreshes `~/.autopg/<app>.env` files, signals consumers, and validates final health.

**Added:** npm `postinstall` hook (`scripts/postinstall.cjs`) auto-runs `autopg upgrade --quiet` when an existing `~/.autopg/data/` is detected on `bun install`. Soft-fails so package install never breaks; manual `autopg upgrade` remains the explicit escape hatch.

**Contract:** Users upgrading from pgserve@2.1.3 to autopg@2.2.x get transparent migration via the postinstall hook. Manual `autopg upgrade` remains as the explicit escape hatch for forced re-runs. Patches the upgrade-path hole left by autopg-v22 partial roll-out (binary moved to `~/.autopg/`, default port silently shifted to 9432, plpgsql extensions referenced stale `$libdir`).

**Override:** Set `AUTOPG_SKIP_POSTINSTALL=1` to bypass the hook (CI / containers / install-only flows).

# Changelog

All notable changes to `pgserve` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — autopg v3.0.0 (post-npm-departure cutover · pgserve → autopg)

v3.0.0 is the **first publishing independently from npmjs.com**. Installs and
in-place updates flow through `install.sh` + GitHub Releases exclusively
(cosign-keyless-signed tarballs). The project is renamed `pgserve` → `autopg`;
the `pgserve` CLI bin is gone. Tracking wish:
[`.genie/wishes/distribution-exodus/WISH.md`](.genie/wishes/distribution-exodus/WISH.md).

### Changed (breaking)

- **CLI rename: `pgserve` → `autopg`.** The `pgserve` shell command is gone
  (clean cutover; no alias). All previous `pgserve <verb>` invocations are
  now `autopg <verb>`. `bin/pgserve-wrapper.cjs` was renamed via `git mv` to
  `bin/autopg-wrapper.cjs` (the previous 16-line `bin/autopg-wrapper.cjs`
  delegator was deleted). `package.json` `bin` map drops the `pgserve`
  entry; only `autopg` remains.
- **Package name: `pgserve` → `autopg`.** `package.json` `name` field
  flipped. No operational impact post-V3-2 (we don't publish to npm); local
  tooling (`bun install`, `npm pack`) reads the new name.
- **`pgserve upgrade` → `autopg update` (clean cutover).** The `upgrade` verb
  is gone; `autopg upgrade` exits with "unknown verb" (the B4 path from
  `pgserve-singleton-no-proxy` G3). Source dir renamed `src/upgrade/` →
  `src/update/`; tests `tests/upgrade/` → `tests/update/`; CLI dispatch +
  wrapper allowlist all updated in lockstep.
- **`update` orchestrator function** in `src/update/index.js` is exported
  as `update()` (was `upgrade()`); the `STEPS` array shape is unchanged.
- **npm publish step removed** from `.github/workflows/version.yml`. v3.0.0+
  releases ship via GitHub Releases only. Historical v2.x tarballs on
  npmjs.com stay published (registry tarballs are immutable); no new
  versions go to npm.
- **`package.json` `postinstall` hook removed.** The hook auto-ran the
  upgrade verb on `npm install` — orphaned after npm departure.
  `scripts/postinstall.cjs` is preserved for manual invocation.

### Preserved (deliberate, deferred)

- **`pgserve_meta` postgres table** — separate from `autopg_meta` with
  different lifecycle (per-database vs per-consumer-app). Renaming requires
  DDL migration on deployed v2.6.x hosts; step-by-step transition.
- **GitHub URLs at `automagik-dev/autopg`** — `install.sh REPO=`, trust
  regex at `src/cosign/trust-list.js`, every `github.com/automagik-dev/autopg`
  doc link. The repo rename to `automagik-dev/autopg` is the LAST cutover
  step (a `gh repo transfer` admin action by the operator); a follow-up
  PR rewrites all URLs + regex in lockstep when that lands.
- **`npm install pgserve@2.6.x`** continues to work for operators who haven't
  migrated; the npm tarballs from v2.x stay published forever. New
  operators install via `install.sh`.

### Removed

- `bin/pgserve-wrapper.cjs` (renamed via `git mv` to `bin/autopg-wrapper.cjs`).
- The previous 16-line `bin/autopg-wrapper.cjs` delegator stub.
- `package.json` `bin.pgserve` entry.
- `.github/workflows/version.yml` `Publish to npm via OIDC` job + 7
  supporting steps.
- `package.json:scripts.postinstall`.

## [2.6.0] / [2.6.1] - 2026-05-09

The 2.6 cohort closes the singleton-G3 sprint and the
`autopg-distribution-cutover-finalize` Wave 1+2 work. v2.6.0 cut the singleton
verbs to npm; v2.6.1 followed with the B2/B3/B4 CLI fix trio.

### Added

- **`autopg doctor`** — read-only health probe for postmaster, pm2 supervision,
  on-disk roots, and trust store. JSON output via `--json`. See
  [`docs/migrations/v2.6-from-v2.5.md`](docs/migrations/v2.6-from-v2.5.md).
- **`autopg trust add | list | remove`** — manage the user-extensible cosign
  trust store at `~/.pgserve/trust/identities.json`. Layered on top of the
  hardcoded `TRUSTED_IDENTITIES` (frozen at build time). See
  [`docs/trust-store.md`](docs/trust-store.md).
- **`autopg gc [--dry-run | --apply]`** — sweep orphan databases (rows in
  `pgserve_meta` whose `source_path` no longer exists). One-line-per-event audit
  log at `~/.pgserve/audit/gc-<YYYY-MM-DD>.log`. Rotates files >90 days old at
  start of each run. See [`docs/pgserve-meta.md`](docs/pgserve-meta.md) for the
  underlying schema.
- **`autopg provision <fingerprint>`** — idempotent DB + role provisioning for
  an app fingerprint. Concurrency-safe via `pg_advisory_lock` keyed on
  fingerprint hash; `42P04` ("database already exists") accepted as success.
- **`autopg create-app <slug>`** — per-consumer app registration with manifest
  LOCK 1 cosign verifier. Writes `~/.autopg/<slug>/admin.json` + sibling
  `manifest.json`, registers in `autopg_meta`, freezes `TRUSTED_IDENTITIES` for
  this consumer at create time. `autopg verify --slug <slug>` consults the
  frozen snapshot.
- **`autopg verify --slug <slug>`** — verify a binary against an app's locked
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
  `github.com/automagik-dev/autopg/releases/download/v<version>/`. Cosign
  attestations live in Sigstore Rekor; verification via `gh attestation verify`
  (no custom verifier server). See
  [`.github/workflows/release-publish.yml`](.github/workflows/release-publish.yml).
- **Hardcoded blocklist** — `autopg install` refuses to start against known-bad
  versions with exit code `EBLOCKEDVERSION`.

### Changed

- **`autopg install`** now runs port pre-flight (IPv4 + IPv6 connect probe on
  5432) and refuses to start on collision. Closes the silent-failure mode
  where pm2 reported `online` while postgres had crashed.
- **`autopg install --help`** respects `--help` / `-h` and exits 0 without
  performing the install.
- **Unknown verbs** (`pgserve foo`) exit non-zero with an "unknown verb" error
  instead of printing top-level help and exiting 0.
- **`autopg doctor`** surfaces a missing `pgaudit` extension as a non-PASS
  finding (was silently fall-through).
- **`autopg config --help`** exits 0 with a usage block instead of running the
  config logic against `--help` as if it were a key.
- **`install.sh`** replaced in-place with the ≤80-line GitHub Releases path.
  No legacy or shim companions; the npm + pm2 install path is preserved via
  `autopg install` (`npm install -g pgserve && autopg install`).

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
  `autopg config list` and `autopg config list` are byte-equivalent.
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
  normal lock conflict. ([#46](https://github.com/automagik-dev/autopg/pull/46),
  fixes [#45](https://github.com/automagik-dev/autopg/issues/45))

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
