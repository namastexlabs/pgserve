# Wish: autopg console — Settings vertical (foundation + first stateful screen)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `autopg-console-settings` |
| **Date** | 2026-04-30 |
| **Author** | felipe@namastex.ai |
| **Appetite** | Big Batch — multi-day |
| **Branch** | `wish/autopg-console-settings` |
| **Design** | [DESIGN.md](../../brainstorms/autopg-console-settings/DESIGN.md) |

## Summary

Ship the foundation for the autopg console (rename, settings file, CLI extension, UI scaffolding) and the first stateful screen — Settings — end-to-end. The CLI is the source of truth; the UI is a static page served by `autopg ui` that reads/writes `~/.autopg/settings.json` through a thin helper. Other 10 design screens scaffold as `[ coming soon ]` placeholders. Health is the next wish.

## Scope

### IN

- Soft rename to `autopg`: same `pgserve` npm package, package now ships **both bins** (`autopg` primary + `pgserve` forever alias). pm2 process name stays `pgserve`. Env vars `AUTOPG_*` primary, `PGSERVE_*` accepted with deprecation log.
- Settings persistence: `~/.autopg/settings.json` with `version: 1` schema (server / runtime / sync / supervision / postgres / ui sections), atomic write + `chmod 0600` + sha256 etag for optimistic concurrency. One-shot migration from `~/.pgserve/`.
- `validateSetting(key, value)` helper with stable error format (`{ code, field, message }`) and 7 error codes; shared between CLI and UI helper.
- CLI subcommands: `autopg config (list / get / set / edit / path / init)`, `autopg restart` (pm2-aware), `autopg ui [--port N] [--no-open]`. All also reachable via `pgserve <same-args>`.
- Daemon wiring: `loadEffectiveConfig()` in `cluster.js` (env > file > defaults), `postgres.js` emits `-c key=value` from `settings.postgres` + `settings.postgres._extra` with GUC name regex + scalar value validation. Hardcoded `max_connections=1000` and WAL replication GUCs promoted into schema.
- UI scaffolding at `console/` (React + Babel CDN, no build step). All 11 routes registered. 10 non-Settings screens render `[ coming soon ]` placeholder.
- Settings screen rebuilt to 6-section schema. Type-aware controls. Raw passthrough panel for additional GUCs. Yellow `OVERRIDDEN BY ENV` chip on env-overridden rows. Inline validation errors. Etag-mismatch reload banner.
- UI helper API surface (4 endpoints inside `autopg ui` http.createServer): `GET /api/settings`, `PUT /api/settings` (with `If-Match`), `POST /api/restart`, `GET /api/status`. All shell out to `autopg <subcommand>`.
- README pivot, CHANGELOG entry, `console/README.md` documenting the soft rename and the local dev loop.

### OUT

- All other 10 design screens (Databases, Tables, SQL, Optimizer, Security, Ingress, Health, Sync, RLM-trace, RLM-sim) — only routed-and-placeholder. Health is the next wish.
- RLM agent integration (`automagik-dev/rlmx`).
- In-process daemon reload — Settings page goes through `autopg restart` → pm2 / kill+respawn, not signal-based reload.
- Telemetry, fingerprint enforcement, ephemeral TTL/reaper, RLS defaults — designed in the bundle but not implemented in pgserve daemon.
- npm package rename — package stays as `pgserve`. No `npm deprecate`.
- pm2 process name change — stays `pgserve`. No migration of supervised installs.
- PG GUC catalog auto-discovery via `pg_settings` — manual curated list of 15 for v1.
- Pre-bundling the UI (no Babel CDN) — later optimization.
- Multi-user / multi-machine UI access — `autopg ui` binds 127.0.0.1 only, single-user dev tool.
- Hard rename of GitHub repo or internal class names.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Transport: CLI-first, no daemon HTTP API.** UI calls a tiny in-process helper that shells out to `autopg`. | User direction. Daemon stays untouched. UI works without a running daemon (you can configure ahead of `pgserve install`). |
| 2 | **Persistence: extend Wave 1's atomic `readConfig`/`writeConfig` in `src/cli-install.cjs`.** | Existing primitive. Add fields, don't invent a layer. |
| 3 | **Soft rename: npm package stays `pgserve`; ship both bins.** | User: "we will keep publishing as pgserve not to keep the train from working". Eliminates the highest-severity rename risks (npx, pm2 migration). |
| 4 | **PG GUC strategy: curated 15 + raw passthrough escape hatch (`settings.postgres._extra`).** | Best of both: structured UX for the 90%, escape hatch for the 10%. |
| 5 | **Settings precedence preserved: env > file > defaults.** | Backward-compatible. UI shows `OVERRIDDEN BY ENV` chip when env wins. |
| 6 | **GUC name validation regex `^[a-z][a-z0-9_]*$`; values must be scalar primitives, no `\n/\r/\0`, no leading `-`.** | No-shell rationale (Bun.spawn array form) plus defense-in-depth at write/boot. |
| 7 | **Concurrent-write guard: sha256 etag on `GET /api/settings`, required `If-Match` on PUT, `409 ETAG_MISMATCH` on conflict.** | Prevents UI/CLI lost-update race. CLI is single-process so no etag needed there. |
| 8 | **`chmod 0600` on `~/.autopg/settings.json` after every write.** | File contains `pgPassword`; rw-owner-only. Windows ACL is equivalent. |
| 9 | **`autopg restart` is pm2-aware: `pm2 restart pgserve` if supervised, else local kill+respawn.** | Avoids double-restart under pm2 supervision. |
| 10 | **UI build: keep React + Babel CDN as the design ships.** | Zero build complexity for v1. Pre-bundle is a future optimization. |

## Success Criteria

- [ ] `autopg config list` prints effective merged config with a source column (file / env / default) per key.
- [ ] `autopg config get postgres.shared_buffers` prints the current value.
- [ ] `autopg config set postgres.shared_buffers 256MB` writes atomically; round-trips through `get`.
- [ ] `autopg config edit` opens `$EDITOR` on the settings file.
- [ ] `autopg config path` prints `~/.autopg/settings.json` (or honors `AUTOPG_CONFIG_DIR`).
- [ ] `autopg config init [--force]` writes the default schema.
- [ ] Validation error: `autopg config set postgres._extra."shared buffers" 128MB` exits 2 with stderr `error: postgres._extra.shared buffers — INVALID_GUC_NAME: …`.
- [ ] `autopg restart` returns 0; pm2-aware (verifiable via `pm2 ls` shows incremented restart count when supervised).
- [ ] `autopg status` (existing) keeps working post-rename, reads from `~/.autopg/`.
- [ ] `autopg ui` opens a browser tab to `127.0.0.1:N` showing the console; `--port` and `--no-open` work.
- [ ] `pgserve <same args>` is interchangeable with `autopg <same args>` (alias).
- [ ] Settings screen renders 6 sections; Save persists; Save & Restart reflects in `SHOW <key>` for postgres GUCs.
- [ ] Theme toggle (MDR / Lumon) and tweaks (phosphor / density / CRT) persist in `settings.ui` and survive reload.
- [ ] `OVERRIDDEN BY ENV` chip appears on rows whose env var is currently set.
- [ ] All 10 non-Settings screens render `[ coming soon ]` placeholder without crashing the shell.
- [ ] Concurrent-write race: a `autopg config set` mid-edit causes UI Save to receive `409 ETAG_MISMATCH` and show a "settings changed, reload?" banner instead of overwriting.
- [ ] `~/.autopg/settings.json` is mode `0600` after every write (verifiable via `stat -f %Sp` / `stat -c %a`).
- [ ] First-run migration on a system with `~/.pgserve/`: settings copy → `~/.autopg/`, `MIGRATED-FROM-PGSERVE.md` marker in old dir, no re-migration on subsequent runs.
- [ ] `PGSERVE_*` env vars still honored at the daemon (one-time deprecation log per process); `AUTOPG_*` wins on conflict.
- [ ] End-to-end smoke test: `bun install && npm link && autopg install && autopg ui` opens Settings; changing `postgres.shared_buffers` from `128MB` → `256MB` + Save & Restart shows `256MB` in `psql -c "SHOW shared_buffers;"`.

## Execution Strategy

| Wave | Group | Agent | Description |
|------|-------|-------|-------------|
| 1 | 1 | engineer | Foundation: soft rename plumbing + settings schema + persistence layer + migration. **Sequential, blocks all later waves.** |
| 2 | 2 | engineer | CLI extension: `autopg config (list/get/set/edit/path/init)` + `autopg restart` + `autopg ui`. **Parallel with Group 3.** |
| 2 | 3 | engineer | Daemon wiring: `loadEffectiveConfig()` in cluster.js + `-c key=value` flag emission in postgres.js. **Parallel with Group 2.** |
| 3 | 4 | engineer | UI scaffolding + Settings screen + UI helper endpoints. **Depends on Group 2 (shells out to CLI) and Group 3 (daemon honors settings).** |
| 4 | 5 | qa | End-to-end smoke test + README/CHANGELOG/console-README. **Depends on Groups 1–4.** |

---

## Execution Groups

### Group 1: Foundation — soft rename + settings persistence

**Goal:** Land the backbone everything else hangs off. Soft rename plumbing, schema, validation, atomic write with etag/chmod, one-shot migration from `~/.pgserve/`. After this group, `~/.autopg/settings.json` is the source of truth, every helper is exported and tested, but no behavior change is visible to a user yet.

**Deliverables:**
1. `package.json` — `bin` field exposes both `autopg` and `pgserve`. `name` stays `pgserve`. `files` includes `console/`.
2. `bin/autopg-wrapper.cjs` (or rename `pgserve-wrapper.cjs` and symlink) — same dispatch logic, both names route to the same dispatcher.
3. `src/settings-schema.js` — schema definition (sections + types + ranges + defaults), exported as data; consumed by validator.
4. `src/settings-loader.js` — `loadEffectiveConfig()`: reads file, merges defaults < file < env, returns `{ settings, sources, etag }` where `sources` marks each leaf key's origin and `etag = sha256(rawFileBytes)`.
5. `src/settings-writer.js` — `writeSettings(newSettings, { ifMatch })`: validates, atomically writes (`tmp + rename`), chmod 0600, returns new etag. Throws `ValidationError(code, field, message)` or `EtagMismatchError(currentEtag)`.
6. `src/settings-validator.js` — `validateSetting(key, value)` and `validateAll(settings)`. Returns `{ ok: true }` or throws `ValidationError`. Implements 7 error codes (`INVALID_KEY`, `INVALID_GUC_NAME`, `INVALID_GUC_VALUE`, `INVALID_TYPE`, `OUT_OF_RANGE`, `READONLY`, `ETAG_MISMATCH`).
7. `src/settings-migrate.js` — first-run check: if `~/.pgserve/` exists and `~/.autopg/` does not, copy contents preserving mtimes; write `MIGRATED-FROM-PGSERVE.md` in old dir. Idempotent.
8. `src/cli-install.cjs` — update `getConfigDir()` to return `~/.autopg/`; preserve `PGSERVE_CONFIG_DIR` env override and add `AUTOPG_CONFIG_DIR` (AUTOPG wins). Wire migrate-on-first-run into the dispatcher's pre-flight.
9. Env var dual-read: `process.env.AUTOPG_FOO ?? process.env.PGSERVE_FOO ?? defaults.foo`. When `PGSERVE_FOO` is the only one set, log a one-time deprecation note via `logger.warn`.
10. Unit tests in `tests/settings/*.test.js` covering schema, loader, writer (incl. atomic + chmod), validator (7 codes), migration (idempotency).

**Acceptance Criteria:**
- [ ] `bun test tests/settings/**/*.test.js` passes.
- [ ] `package.json` `bin` field exposes `autopg` AND `pgserve`. `npm pack` includes the `console/` directory once D ships it (slot reserved here).
- [ ] `loadEffectiveConfig()` returns `{ settings, sources, etag }`; `etag` is deterministic for unchanged files.
- [ ] `writeSettings()` produces a file with mode `0600` (Unix) and atomic swap.
- [ ] `validateSetting('postgres._extra.shared buffers', '128MB')` throws `ValidationError` with `code === 'INVALID_GUC_NAME'`.
- [ ] `validateSetting('postgres.shared_buffers', '128MB\n--malicious')` throws with `code === 'INVALID_GUC_VALUE'`.
- [ ] First run on a system with `~/.pgserve/config.json` migrates to `~/.autopg/settings.json`; second run is a no-op (marker file present).
- [ ] `PGSERVE_PORT=9000 autopg config get server.port` returns `9000`; if both set, `AUTOPG_PORT` wins.

**Validation:**
```bash
bun test tests/settings/**/*.test.js && \
  node -e "console.log(require('./src/settings-loader').loadEffectiveConfig())" && \
  stat -c %a ~/.autopg/settings.json 2>/dev/null || stat -f %Sp ~/.autopg/settings.json
```

**depends-on:** none

---

### Group 2: CLI extension — config / restart / ui

**Goal:** Expose the persistence + restart + UI launcher behind `autopg <subcommand>`, wired through the existing Wave 1 dispatcher. Nothing daemon-side changes yet.

**Deliverables:**
1. `src/cli-install.cjs` `dispatch()` — add cases: `config` (sub-router), `restart`, `ui`. Update `__installSubcommands` set in `bin/pgserve-wrapper.cjs`.
2. `src/cli-config.cjs` (new) — sub-router for `config list / get / set / edit / path / init`. Uses `settings-loader` and `settings-writer` from Group A. Exit codes: 0 ok, 2 validation error, 1 unknown.
3. `src/cli-restart.cjs` (new) — detects pm2 supervision (process named `pgserve` exists in `pm2 jlist`). If yes: `pm2 restart pgserve`. Else: read pidfile, send SIGTERM, wait, respawn via `pgserve daemon`.
4. `src/cli-ui.cjs` (new) — `node:http.createServer` bound to 127.0.0.1, port from `--port` or auto-pick free in `8433-8533`. Serves static files from `console/`. Mounts 4 endpoints (`GET /api/settings`, `PUT /api/settings`, `POST /api/restart`, `GET /api/status`) — handlers shell out via `child_process.execFileSync('autopg', […])`. Opens browser via `open` package or platform fallback (`open` macOS / `xdg-open` Linux / `start` Windows). `--no-open` suppresses browser launch.
5. `bin/pgserve-wrapper.cjs` — extend `__installSubcommands` to include `config`, `restart`, `ui` so they bypass the bun-probe (these are pure node-side).
6. Output formatting: `autopg config list` prints a 3-column table (key | value | source). `autopg config get` prints just the value (machine-friendly).
7. Tests in `tests/cli/*.test.js`: dispatch cases, error format on bad input, `ui` server boot + endpoint responses (mock `execFileSync`).

**Acceptance Criteria:**
- [ ] `autopg config list` outputs ≥ 1 row per schema leaf with a `source` column.
- [ ] `autopg config get postgres.shared_buffers` outputs only the value, exit 0.
- [ ] `autopg config set foo bar` exits 2 with stderr `error: foo — INVALID_KEY: …`.
- [ ] `autopg config path` outputs `~/.autopg/settings.json` (or `AUTOPG_CONFIG_DIR/settings.json`).
- [ ] `autopg config init` writes defaults; `--force` overwrites; refuses to clobber without `--force`.
- [ ] `autopg restart` (pm2 not supervised) sends SIGTERM and respawns, returns 0.
- [ ] `autopg ui` boots a server on 127.0.0.1, prints the URL, opens default browser unless `--no-open`. Returns 0 on Ctrl-C.
- [ ] `pgserve config list` is byte-equivalent to `autopg config list` (alias works).
- [ ] `bun test tests/cli/**/*.test.js` passes.

**Validation:**
```bash
bun test tests/cli/**/*.test.js && \
  autopg config init --force && \
  autopg config set postgres.shared_buffers 192MB && \
  test "$(autopg config get postgres.shared_buffers)" = "192MB" && \
  autopg config list | head -5
```

**depends-on:** Group 1

---

### Group 3: Daemon wiring — loadEffectiveConfig + PG GUC application

**Goal:** Make the daemon read from `settings.json` and apply `settings.postgres.*` as `-c key=value` flags. After this group, `autopg restart` actually reflects file changes in postgres behavior.

**Deliverables:**
1. `src/cluster.js:550-559` — replace direct `process.env.PGSERVE_*` reads with a single call to `loadEffectiveConfig()`. Map result to the existing options object shape so downstream code is unchanged.
2. `src/postgres.js:760-794` — replace hardcoded `-c max_connections=1000` and the conditional WAL block with a loop:
   ```
   for (const [k, v] of Object.entries({ ...settings.postgres, ...(settings.postgres._extra || {}) })) {
     if (k === '_extra') continue;
     // re-validate at boot (defense in depth); skip + warn on invalid
     pgArgs.push('-c', `${k}=${v}`);
   }
   ```
   Curated keys win on conflict: build the map with `_extra` first, curated second, so curated overwrites.
3. Boot-time validation: any invalid key/value in settings.postgres logs a `logger.warn` with the offending entry and is dropped (not crashed). Postgres itself is the final validator for value semantics.
4. Promote hardcoded `max_connections=1000` and WAL replication GUCs (`wal_level=logical`, `max_replication_slots=10`, `max_wal_senders=10`, `wal_keep_size=512MB`) into the settings schema defaults (Group A's schema gets these as defaults; Group C plumbs them through).
5. Sync mode: if `settings.sync.enabled === true`, set the WAL GUCs as defaults (overridable by user).
6. Tests in `tests/daemon-config/*.test.js`: spawn args contain expected `-c` flags; invalid GUC drops + logs; env override beats file.

**Acceptance Criteria:**
- [ ] Setting `postgres.shared_buffers = "256MB"` then `autopg restart` results in `ps aux | grep postgres` showing `-c shared_buffers=256MB`.
- [ ] `psql -c "SHOW shared_buffers;"` returns `256MB`.
- [ ] Adding `_extra: { log_statement: "all" }` and restarting produces `-c log_statement=all` in the args list.
- [ ] Invalid GUC name in `_extra` (e.g., `"FOO BAR": "1"`) is skipped at boot with a `logger.warn`; postgres still starts.
- [ ] `PGSERVE_PORT=9000` overrides `settings.server.port=8432` at daemon start (logger logs deprecation).
- [ ] `bun test tests/daemon-config/**/*.test.js` passes.

**Validation:**
```bash
bun test tests/daemon-config/**/*.test.js && \
  autopg config set postgres.shared_buffers 256MB && \
  autopg restart && \
  sleep 2 && \
  psql postgresql://localhost:8432/postgres -c "SHOW shared_buffers;" | grep -q 256MB
```

**depends-on:** Group 1

---

### Group 4: UI scaffolding + Settings screen + UI helper endpoints

**Goal:** Drop the design files into `console/`, register all 11 routes, replace 10 non-Settings screens with `[ coming soon ]` placeholders, rebuild Settings to the 6-section schema, and wire the API endpoints to the CLI shell-outs.

**Deliverables:**
1. `console/` directory at repo root, populated from the design archive at `/tmp/autopg-design/pgserve/project/design-system/ui_kits/pgserve-console/`. Asset paths fixed (the design imports `../../colors_and_type.css`; we copy `colors_and_type.css` into `console/` and update the import).
2. `console/index.html` — entry. React + Babel via CDN with pinned versions and integrity hashes from the design.
3. `console/app.jsx` — shell + routing. Sidebar lists all 11 sections; only Settings has functional content in v1. Topbar pgserve identity becomes `autopg`.
4. `console/components.jsx`, `console/data.jsx`, `console/tweaks-panel.jsx`, `console/console.css`, `console/colors_and_type.css` — copied verbatim from the design.
5. `console/api.js` — client wrapper around `fetch`. Stores etag from latest GET; sends `If-Match` on PUT; surfaces `409 ETAG_MISMATCH` and other error codes.
6. `console/screens/settings.jsx` — **rewritten** to match the 6-section schema (server, runtime, sync, supervision, postgres, ui). Type-aware controls: toggles for booleans, `<input type=number>` for ints, `<Seg>` for enums, `<input>` for strings/durations. Postgres section: 15 curated GUC controls + a "raw passthrough" panel below with editable key/value rows + add/remove buttons. Each row checks `sources[key]` and shows the yellow `OVERRIDDEN BY ENV` chip when env is the source. Validation errors render inline next to the field.
7. `console/screens/{databases,tables,sql,optimizer,security,ingress,health,sync,rlm-trace,rlm-sim}.jsx` — replaced with a tiny placeholder component that prints `[ coming soon ]` inside the standard `<page>` shell.
8. UI helper endpoints inside `src/cli-ui.cjs` (Group B sets up the server; Group D fills in the handlers):
   - `GET /api/settings` → `{ settings, sources, etag }` from `loadEffectiveConfig()`.
   - `PUT /api/settings` → reads `If-Match` header, calls `writeSettings(body, { ifMatch })`. Returns 200 + new etag, or 409 + new etag, or 4xx + error shape.
   - `POST /api/restart` → invokes `cli-restart.cjs`, streams stdout/stderr to client.
   - `GET /api/status` → wraps `pgserve status` (existing Wave 1).
9. UI tests: lightweight smoke via Bun's DOM (or a Playwright/JSDOM script) that mounts `<App />` against a mock api.js, walks the routes, asserts each renders without throwing.

**Acceptance Criteria:**
- [ ] `autopg ui` opens the console; sidebar shows all 11 sections; clicking each non-Settings entry renders `[ coming soon ]`.
- [ ] Settings screen shows the 6 sections; Save persists to `~/.autopg/settings.json`; UI re-renders with the post-save etag.
- [ ] Editing `postgres._extra` (adding `{"log_statement": "all"}`) and Save & Restart results in `-c log_statement=all` in the running daemon's args.
- [ ] Yellow `OVERRIDDEN BY ENV` chip appears on `server.port` when `PGSERVE_PORT` or `AUTOPG_PORT` is set in the daemon's env.
- [ ] Invalid GUC name in raw passthrough is rejected at Save with the field's row showing `INVALID_GUC_NAME: …` inline.
- [ ] Etag-mismatch flow: while UI form is dirty, run `autopg config set ui.theme lumon` from a shell; clicking Save in UI shows a "settings changed, reload?" banner with no overwrite.
- [ ] Theme toggle (MDR / Lumon) persists in `settings.ui.theme` and survives a full reload.
- [ ] All 10 non-Settings screens render without throwing; `console.error` is empty during a 30-second walk-through.
- [ ] The console directory is included in `npm pack` (no missing files).

**Validation:**
```bash
# Smoke: boot UI, GET settings, edit one field, PUT, verify, then read back
autopg ui --no-open --port 8434 &
sleep 1
curl -sf http://127.0.0.1:8434/api/settings | jq -r .etag > /tmp/etag
ETAG=$(cat /tmp/etag)
curl -sf -X PUT -H "If-Match: $ETAG" -H "Content-Type: application/json" \
  -d '{"postgres":{"shared_buffers":"192MB"}}' http://127.0.0.1:8434/api/settings | jq .
test "$(autopg config get postgres.shared_buffers)" = "192MB"
kill %1
```

**depends-on:** Group 1, Group 2, Group 3

---

### Group 5: End-to-end smoke test + documentation

**Goal:** Prove the full loop works on a fresh checkout and document the soft rename so a new contributor can find their way.

**Deliverables:**
1. `tests/e2e/settings-flow.test.js` — drives the full scenario in code: install → ui boot → curl PUT → restart → SHOW. Skipped on CI by default; runnable via `bun test tests/e2e --bail`.
2. `README.md` pivot — keep `pgserve` as the npm package name, document `autopg` as the new CLI. Add a "Console" section linking to `console/README.md`. Document `~/.autopg/settings.json`.
3. `CHANGELOG.md` — one block describing the soft rename, the new schema, the CLI surface, and the local dev loop. Migration note for `~/.pgserve/` users.
4. `console/README.md` — what's in `console/`, how to run via `autopg ui`, the screen-by-screen rollout (Settings is functional, others coming soon), and the design-system source.
5. `docs/settings-schema.md` (or inline in README) — generated/curated reference of every key in `~/.autopg/settings.json` with type, default, env equivalent.
6. Demo recording (optional): a 30-second screencast of the Settings flow committed as `docs/console-settings.gif` or similar. Skip if `make screencast` not feasible.

**Acceptance Criteria:**
- [ ] On a fresh clone: `bun install && npm link && autopg install && autopg ui` succeeds end-to-end.
- [ ] Editing `postgres.shared_buffers` from `128MB` → `256MB` in the UI + clicking Save & Restart, then `psql -c "SHOW shared_buffers;"` returns `256MB`.
- [ ] `ps aux | grep postgres` after restart shows the corresponding `-c shared_buffers=256MB` flag.
- [ ] `autopg restart` under pm2 supervision (`autopg install && autopg restart && pm2 ls | grep pgserve`) does not double-fire (restart count increments by exactly 1).
- [ ] README + CHANGELOG + console/README.md committed; `npm pack` ships the `console/` directory.
- [ ] `bun test tests/e2e/settings-flow.test.js` passes locally.

**Validation:**
```bash
git clean -fdx node_modules && \
  bun install && \
  npm link && \
  autopg install --port 8432 && \
  bun test tests/e2e/settings-flow.test.js
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Dependencies

- **depends-on:** none (self-contained foundation work; the brainstorm DESIGN.md is referenced but not blocking)
- **blocks:** `autopg-console-health` (next wish, depends on this wish's UI scaffolding + CLI extension)

## QA Criteria

After merge to dev:
- Run `autopg install` on a clean container; verify settings.json is created with mode 0600.
- Run UI smoke (Group D validation block) and assert no console errors in the browser.
- Run e2e (Group E validation block) and assert SHOW returns the new value.
- Verify legacy `pgserve <subcommand>` still works for every existing Wave 1 command.

## Assumptions / Risks

- **Bun.spawn array form** prevents shell injection by construction; the GUC-name regex + scalar-only values are defense-in-depth.
- **pm2 supervision** is detected via `pm2 jlist` — if pm2 is installed but the process isn't supervised, `autopg restart` falls through to local kill+respawn.
- **First-run migration** is best-effort: if the user has both `~/.pgserve/` and `~/.autopg/`, we leave both as-is and use `~/.autopg/`. No automatic merge.
- **Babel CDN integrity hashes** must be re-pinned if the design upgrades React. Document the pinning policy in `console/README.md`.
- **`open` package** has a 100KB+ dep tree. If we want to avoid it, `child_process.exec` with platform-specific commands is a 20-line alternative — pick at implementation time.
