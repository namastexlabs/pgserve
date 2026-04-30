# Changelog

All notable changes to `pgserve` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
