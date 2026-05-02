# `console/` — autopg console

Local web console served by `autopg ui`. React + Babel via CDN, no build
step. Single-user dev tool — binds 127.0.0.1 only, no auth, no TLS.

## Run

```bash
autopg ui                 # walks 8433–8533 picking the first free port
autopg ui --port 8500     # bind exactly 8500 or fail
autopg ui --no-open       # skip browser launch (CI / headless)
```

`pgserve ui …` is a forever alias of the same command.

The server boots in-process via `node:http` and serves this directory as
its document root. Four helper endpoints are mounted alongside the static
assets — every mutation shells out to the CLI rather than calling the
daemon directly, so the console works with or without a running daemon.

| Endpoint | Backed by |
|----------|-----------|
| `GET /api/settings` | `loadEffectiveConfig()` → `{ settings, sources, etag }` |
| `PUT /api/settings` | `writeSettings(body, { ifMatch })` (409 on stale `If-Match`) |
| `POST /api/restart` | `cli-restart.cjs` (pm2-aware) |
| `GET /api/status`   | shells out to `autopg status --json` |

## Layout

```
console/
├── README.md                   # this file
├── index.html                  # entry — pinned React + Babel CDN scripts
├── app.jsx                     # shell + sidebar router (11 routes)
├── api.js                      # fetch wrapper, holds latest etag, surfaces ETAG_MISMATCH
├── components.jsx              # shared widgets (Seg, Toggle, Field, …)
├── data.jsx                    # demo data fixtures (used by placeholder screens)
├── tweaks-panel.jsx            # theme/phosphor/density/CRT toggles (persists to settings.ui)
├── colors_and_type.css         # design tokens
├── console.css                 # layout + screen styles
└── screens/
    ├── settings.jsx            # ✅ functional — 6-section schema editor
    ├── databases.jsx           # [ coming soon ]
    ├── tables.jsx              # [ coming soon ]
    ├── sql.jsx                 # [ coming soon ]
    ├── optimizer.jsx           # [ coming soon ]
    ├── security.jsx            # [ coming soon ]
    ├── ingress.jsx             # [ coming soon ]
    ├── health.jsx              # [ coming soon ] — next wish
    ├── sync.jsx                # [ coming soon ]
    ├── rlm-trace.jsx           # [ coming soon ]
    └── rlm-sim.jsx             # [ coming soon ]
```

## Screen rollout

| Screen | Status | Notes |
|--------|--------|-------|
| Settings | ✅ functional | 6 sections, type-aware controls, raw GUC passthrough, etag concurrency, env-override chip |
| Health | 🟡 next | Live cluster health metrics — next wish |
| Databases | ⚪ placeholder | List + create + drop |
| Tables | ⚪ placeholder | Per-DB table inspector |
| SQL | ⚪ placeholder | Ad-hoc query runner |
| Optimizer | ⚪ placeholder | Plan inspector / GUC tuner suggestions |
| Security | ⚪ placeholder | Roles, RLS, audit log |
| Ingress | ⚪ placeholder | Listener / TLS / token surface |
| Sync | ⚪ placeholder | Replication-slot status |
| RLM-trace | ⚪ placeholder | RLM agent trace viewer (depends on rlmx) |
| RLM-sim | ⚪ placeholder | RLM scenario simulator (depends on rlmx) |

## Local dev loop

The console is shipped as static files — no build, no bundler. Edit the
`.jsx` files in place; refresh the browser tab to pick up the change
(Babel transpiles in the browser at load time). The CDN scripts are
pinned with SRI integrity hashes — bumping React or Babel requires
re-pinning the matching `integrity="sha384-…"` attribute in
[`index.html`](./index.html).

```bash
autopg ui --no-open --port 8500 &
open http://127.0.0.1:8500
# … edit screens/settings.jsx, refresh browser …
kill %1
```

The Settings screen reads live state from `~/.autopg/settings.json`
through the helper endpoints, so changes survive reload and round-trip
through `autopg config get` from another shell.

### Concurrency model

`api.js` stores the etag returned by every successful GET and sends it
back as `If-Match` on the next PUT. If a parallel `autopg config set` (or
another browser tab) drifts the file, the PUT comes back as
`409 ETAG_MISMATCH` with a fresh `currentEtag`. The Settings screen
catches this and shows a "settings changed, reload?" banner instead of
overwriting the operator's other changes.

### Env-override chip

`GET /api/settings` returns a `sources` map (one entry per leaf:
`'default' | 'file' | 'env:<NAME>'`). Rows whose source starts with
`env:` render a yellow `OVERRIDDEN BY ENV` chip — Save still writes the
file, but `loadEffectiveConfig()` will keep returning the env value
until the env var is unset or the daemon is restarted with a clean
environment.

## Design system

The console UI is derived from the `pgserve-console` design kit at
`namastex-design-system/ui_kits/pgserve-console`. The CSS files
(`colors_and_type.css`, `console.css`) and the shared widgets
(`components.jsx`, `tweaks-panel.jsx`) are copied verbatim — the
soft rename only touches the topbar identity (`pgserve` → `autopg`)
and the Settings screen, which was rewritten to match the
6-section schema documented in
[`docs/settings-schema.md`](../docs/settings-schema.md).

## What's deliberately not here

- **No build step.** Pre-bundling is a future optimization. The CDN +
  Babel-in-browser path is intentional for v1 — zero infrastructure.
- **No daemon HTTP API.** The CLI is the source of truth; every UI
  mutation shells out. This means the UI works ahead of `autopg
  install` (you can configure before the daemon ever runs) and
  cannot leak privileges through a long-lived listening socket.
- **No multi-user / multi-machine access.** 127.0.0.1 only, by
  design.
- **No telemetry, no analytics.** Static page + four endpoints, all
  local.
