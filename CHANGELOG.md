## v2.2.x — Transparent Upgrade

**Added:** `autopg upgrade` CLI verb — idempotent migration runner that reconciles port back to canonical 8432, flushes the binary cache against the pinned PG version, re-resolves the plpgsql `.so` path per database, refreshes `~/.autopg/<app>.env` files, signals consumers, and validates final health.

**Added:** npm `postinstall` hook (`scripts/postinstall.cjs`) auto-runs `autopg upgrade --quiet` when an existing `~/.autopg/data/` is detected on `bun install`. Soft-fails so package install never breaks; manual `autopg upgrade` remains the explicit escape hatch.

**Contract:** Users upgrading from pgserve@2.1.3 to autopg@2.2.x get transparent migration via the postinstall hook. Manual `autopg upgrade` remains as the explicit escape hatch for forced re-runs. Patches the upgrade-path hole left by autopg-v22 partial roll-out (binary moved to `~/.autopg/`, default port silently shifted to 9432, plpgsql extensions referenced stale `$libdir`).

**Override:** Set `AUTOPG_SKIP_POSTINSTALL=1` to bypass the hook (CI / containers / install-only flows).

# Changelog

All notable changes to `pgserve` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
