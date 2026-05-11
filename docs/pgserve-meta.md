# pgserve metadata schemas

This is the operator reference for the two metadata tables pgserve maintains in
`postgres`: `pgserve_meta` (per-database) and `autopg_meta` (per-consumer-app).
Both live in the `public` schema. Both are bootstrapped lazily — `pgserve
provision` and `autopg create-app` invoke their respective `IF NOT EXISTS`
DDL on first use.

## `pgserve_meta`

**Owner:** `autopg provision` / `autopg gc`
**Lifecycle:** one row per provisioned database
**Bootstrap:** `src/schema/pgserve-meta.js#getBootstrapStatements()` (idempotent)

| Column | Type | Constraint | Purpose |
|--------|------|-----------|---------|
| `fingerprint` | `TEXT` | `PRIMARY KEY` | sha256 fingerprint of the app's `package.json` (or fallback `(uid, sha256(cwd + cmdline[1])[:12])` for scripts without a package.json) |
| `database_name` | `TEXT` | `NOT NULL UNIQUE` | name of the database created for this fingerprint; guards against accidental dupes |
| `role_name` | `TEXT` | `NOT NULL` | postgres role provisioned alongside the database |
| `publisher` | `TEXT` | nullable | identity of the publisher (path-tier installs may have none) |
| `source_path` | `TEXT` | nullable | absolute path to the package.json that anchored the fingerprint; gc uses absence of this path as the orphan signal |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | set on first provision |
| `last_used_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | touched by provision on idempotent re-run; gc uses this as the staleness signal |

**Cosign verification columns** (`verified_at`, `verified_identity`,
`verified_tier`) are layered on top via `src/cosign/schema.js` —
they `ALTER TABLE` after the base CREATE. See `src/cosign/cosign-meta-migration.js`
for the migration shape and idempotency contract.

### How rows are created

```text
autopg provision <fingerprint>
  ├─ pg_advisory_lock(hash(fingerprint))
  ├─ INSERT INTO pgserve_meta (fingerprint, database_name, role_name, …)
  │     ON CONFLICT (fingerprint) DO UPDATE SET last_used_at = now()
  └─ pg_advisory_unlock
```

The advisory lock keys on the fingerprint hash so two concurrent provisions for
the same fingerprint are serialized; provisions for different fingerprints run
in parallel. The `42P04` ("database already exists") error is treated as
success during the underlying `CREATE DATABASE`.

### How rows are deleted

```text
autopg gc [--apply]
  ├─ SELECT fingerprint, database_name, source_path, last_used_at FROM pgserve_meta
  ├─ FOR EACH row WHERE source_path IS NOT NULL AND NOT EXISTS(source_path):
  │     DROP DATABASE database_name
  │     DELETE FROM pgserve_meta WHERE fingerprint = …
  │     # audit-log line written to ~/.pgserve/audit/gc-<DATE>.log
  └─ rotate audit-log files older than 90 days at end of run
```

`gc --dry-run` prints the same plan without executing the destructive steps.
The audit log captures `start` / `skip` / `drop` / `finish` / `rotate` events
keyed by op-id; redaction lint ensures no fingerprint hashes leak verbatim.

## `autopg_meta`

**Owner:** `autopg create-app`
**Lifecycle:** one row per consumer app
**Bootstrap:** `src/schema/autopg-meta.js#getBootstrapStatements()` (idempotent)

| Column | Type | Constraint | Purpose |
|--------|------|-----------|---------|
| `slug` | `TEXT` | `PRIMARY KEY` | sanitized consumer slug — `sanitizeSlug()` from `src/provision/db-naming.js` (e.g. `@demo/app` → `demo_app`) |
| `manifest_path` | `TEXT` | `NOT NULL` | absolute path to the per-consumer cache file at `~/.autopg/<slug>/manifest.json` |
| `locked_roots` | `JSONB` | `NOT NULL` | snapshot of `TRUSTED_IDENTITIES` (from `src/cosign/trust-list.js`) at the moment `create-app` ran; manifest LOCK 1 |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | set on first create-app |
| `last_updated` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | touched by every idempotent re-run; `locked_roots` stays untouched |

### How rows are created

```text
autopg create-app <slug>
  ├─ sanitizeSlug(<slug>) → e.g. "demo_app"
  ├─ ensure ~/.autopg/<slug>/ exists (mode 0700)
  ├─ INSERT INTO autopg_meta (slug, manifest_path, locked_roots, …)
  │     ON CONFLICT (slug) DO UPDATE SET last_updated = now()
  │     -- locked_roots intentionally NOT in the UPDATE clause: idempotent
  │     -- re-runs preserve the original lock
  ├─ write ~/.autopg/<slug>/admin.json (mode 0600) — derived cache
  └─ write ~/.autopg/<slug>/manifest.json (mode 0600) — derived cache
       schema: { schemaVersion: 1, slug, lockedRoots, createdAt, lastUpdated }
```

### How `autopg verify --slug` reads the table

```text
autopg verify --slug <slug> <binary>
  ├─ SELECT locked_roots FROM autopg_meta WHERE slug = <slug>
  ├─ verifyBinary(<binary>, options: { trustList: locked_roots })
  └─ exit 0 on PASS, non-zero on FAIL (exit-3 if slug not found, exit-2 if identity mismatch)
```

### Source-of-truth split

`autopg_meta` is the **authoritative** source for "which apps exist + what
trust roots are locked at create time."  The per-consumer `admin.json` +
`manifest.json` are **derived caches** — written at create-app time for fast
reads from CLI verbs that don't want a postgres connection (`autopg doctor`,
`autopg update` pre-flight — renamed from `pgserve upgrade` in v3.0.0).

On divergence, `autopg_meta` wins.  The next `autopg doctor` run reports the
divergence as a `FAIL` finding.  Cache regeneration in v2.6 V1 is manual: the
operator removes `~/.autopg/<slug>/` and re-runs `autopg create-app <slug>`.
The verb is idempotent and reads back `locked_roots` from the table to rebuild
the cache files.

Auto-regeneration via `autopg doctor --fix` is owned by
`pgserve-singleton-no-proxy` Group 6 (self-healing update) and ships in a
separate cohort.  Until then, `autopg doctor --fix` is a stub that exits 64.

### Why two tables, not one

Different lifecycles:

- `pgserve_meta` rows are keyed by **fingerprint** (a content hash of the app's
  `package.json`); they are created by `provision` only when a database is
  actually needed; they are deleted by `gc` when their source path disappears.
- `autopg_meta` rows are keyed by **slug** (an operator-chosen consumer name);
  they are created by `create-app` proactively, often before any database
  exists; they survive across multiple `provision`/`gc` cycles.

Merging them would couple two unrelated GC strategies and force one table to
carry the union of both invariants.

## Cross-references

- [`docs/migrations/v2.6-from-v2.5.md`](migrations/v2.6-from-v2.5.md) — what to do
  during the upgrade.
- [`docs/trust-store.md`](trust-store.md) — `~/.pgserve/trust/identities.json`
  format + `autopg trust` verb reference.
- [`src/schema/pgserve-meta.js`](../src/schema/pgserve-meta.js) — bootstrap source.
- [`src/schema/autopg-meta.js`](../src/schema/autopg-meta.js) — bootstrap source.
- [`src/cosign/schema.js`](../src/cosign/schema.js) — verified-* column delta on `pgserve_meta`.
