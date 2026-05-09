/**
 * `pgserve create-app <slug>` — autopg-distribution-cutover-finalize G3 verb.
 *
 * Registers a consumer app with pgserve:
 *   1. Bootstraps the `public.autopg_meta` table (idempotent IF NOT EXISTS).
 *   2. INSERTs a row keyed by sanitized slug, freezing the current
 *      `TRUSTED_IDENTITIES` snapshot into `locked_roots` JSONB at the
 *      moment of creation (the LOCK).
 *   3. Writes the per-consumer cache pair to disk:
 *        ~/.autopg/<slug>/admin.json      (mode 0600)
 *        ~/.autopg/<slug>/manifest.json   (mode 0600)
 *      under a 0700 directory.
 *
 * Idempotency contract (BRIEF v5 A6):
 *   On re-run with the same slug, the verb touches `last_updated` only.
 *   It does NOT re-lock `locked_roots` to the current TRUSTED_IDENTITIES
 *   — the original snapshot from first-create is preserved. This is what
 *   makes the upgrade-after-trust-rotation invariant pass: an existing
 *   slug's verifier continues to use its frozen lock even after operators
 *   mutate the live trust list via `pgserve trust add` / `remove`.
 *
 * Composes:
 *   - src/schema/autopg-meta.js          → bootstrapAutopgMeta + columns
 *   - src/admin/admin-bootstrap.js       → bootstrapConsumerAdmin
 *   - src/cosign/trust-list.js           → TRUSTED_IDENTITIES (the lock)
 *   - src/lib/admin-json.js              → readAdminJson (port discovery)
 *   - src/lib/pg-query.js                → pgQuery + quoteLiteral
 *
 * Exit codes:
 *   0  registered (or no-op idempotent re-run)
 *   1  user error (bad flags, empty slug, slug sanitizes to empty)
 *   2  pgserve postmaster unreachable / cannot bootstrap autopg_meta
 *   3  postgres error during create / select / update sequence
 */

import { readAdminJson } from '../lib/admin-json.js';
import { bootstrapAutopgMeta } from '../schema/autopg-meta.js';
import { bootstrapConsumerAdmin } from '../admin/admin-bootstrap.js';
import { TRUSTED_IDENTITIES } from '../cosign/trust-list.js';
import { pgQuery, quoteLiteral } from '../lib/pg-query.js';
import { sanitizeSlug } from '../provision/db-naming.js';

const USAGE = `Usage: pgserve create-app <slug> [options]

  <slug>                   consumer slug (sanitized via sanitizeSlug;
                           e.g. "@demo/app" -> "demo_app").

  --port <N>               override the postgres port (default: read
                           ~/.autopg/admin.json or 5432).
  --json                   emit a JSON summary on stdout.
  -h, --help               show this help.

Idempotent: re-running with the same slug touches last_updated only.
The locked_roots snapshot from first-create is preserved — this is what
keeps existing consumers verifiable after operator-driven trust rotation.

Source-of-truth split:
  public.autopg_meta is authoritative.
  The per-consumer admin.json + manifest.json are derived caches.
  On divergence, re-run \`pgserve create-app <slug>\` to regenerate them
  from the table (the v2.4 read-only doctor surface flags divergence;
  --fix tiered modes are deferred to a future wave).`;

function parseFlags(argv) {
  const out = { json: false, port: undefined, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--port':
      case '-p': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          throw new Error('--port requires an integer in [1, 65535]');
        }
        out.port = v;
        break;
      }
      default:
        if (a.startsWith('--')) {
          throw new Error(`unknown flag: ${a}`);
        }
        out.positional.push(a);
    }
  }
  return out;
}

function resolvePort(opts) {
  if (typeof opts.port === 'number') return opts.port;
  try {
    const admin = readAdminJson();
    if (admin && Number.isInteger(admin.port) && admin.port > 0) return admin.port;
  } catch {
    /* admin.json absent — fall through */
  }
  return 5432;
}

/**
 * Adapter: shape `pgQuery` to the node-postgres-compatible
 * `client.query(sql)` contract that bootstrapAutopgMeta expects.
 * Mirrors src/commands/provision.js#makePsqlClient.
 */
function makePsqlClient({ port, db }) {
  return {
    query: async (sql) => pgQuery({ sql, port, db }),
  };
}

async function ensureAutopgMetaSchema({ port }) {
  const client = makePsqlClient({ port, db: 'postgres' });
  await bootstrapAutopgMeta(client);
}

/**
 * Look up an existing autopg_meta row for the slug. Returns
 * `{ slug, manifestPath, lockedRoots, createdAt, lastUpdated }` or null.
 *
 * `locked_roots` is JSONB; psql returns it as a JSON string, parsed
 * here. Timestamps are returned as ISO 8601 (psql `TIMESTAMPTZ` default
 * format); we re-emit them through `new Date().toISOString()` so the
 * cache-write side gets a stable shape.
 */
function selectAutopgMetaRow({ port, slug }) {
  const out = pgQuery({
    sql: [
      'SELECT',
      "  slug,",
      "  manifest_path,",
      "  locked_roots::text,",
      "  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),",
      "  to_char(last_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
      'FROM public.autopg_meta',
      `WHERE slug = ${quoteLiteral(slug)}`,
      'LIMIT 1',
    ].join('\n'),
    port,
    captureStdout: true,
  });
  if (!out) return null;
  const [foundSlug, manifestPath, lockedRootsJson, createdAt, lastUpdated] = out.split('\t');
  if (!foundSlug) return null;
  let lockedRoots;
  try {
    lockedRoots = JSON.parse(lockedRootsJson);
  } catch (err) {
    const wrap = new Error(
      `pgserve create-app: failed to parse locked_roots for slug "${foundSlug}": ${err.message}`,
    );
    wrap.cause = err;
    throw wrap;
  }
  return {
    slug: foundSlug,
    manifestPath,
    lockedRoots,
    createdAt,
    lastUpdated,
  };
}

function insertAutopgMetaRow({ port, slug, manifestPath, lockedRoots, nowIso }) {
  pgQuery({
    sql: [
      'INSERT INTO public.autopg_meta',
      '  (slug, manifest_path, locked_roots, created_at, last_updated)',
      'VALUES (',
      `  ${quoteLiteral(slug)},`,
      `  ${quoteLiteral(manifestPath)},`,
      `  ${quoteLiteral(JSON.stringify(lockedRoots))}::jsonb,`,
      `  ${quoteLiteral(nowIso)}::timestamptz,`,
      `  ${quoteLiteral(nowIso)}::timestamptz`,
      ')',
    ].join('\n'),
    port,
  });
}

function touchAutopgMetaRow({ port, slug, manifestPath, nowIso }) {
  // Update `last_updated` + `manifest_path` (the latter may have shifted
  // if the operator re-ran with a different AUTOPG_CONFIG_DIR). Crucially
  // does NOT touch `locked_roots` — that's the lock-preservation
  // invariant per BRIEF v5 A6.
  pgQuery({
    sql: [
      'UPDATE public.autopg_meta SET',
      `  manifest_path = ${quoteLiteral(manifestPath)},`,
      `  last_updated = ${quoteLiteral(nowIso)}::timestamptz`,
      `WHERE slug = ${quoteLiteral(slug)}`,
    ].join('\n'),
    port,
  });
}

function deepCloneRoots(lockedRoots) {
  return JSON.parse(JSON.stringify(lockedRoots));
}

function emit({ json, summary, humanLines }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    for (const line of humanLines) process.stdout.write(`${line}\n`);
  }
}

export async function runCreateApp(argv = []) {
  let opts;
  try {
    opts = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`pgserve create-app: ${err.message}\n\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const inputSlug = opts.positional[0];
  if (typeof inputSlug !== 'string' || inputSlug.trim().length === 0) {
    process.stderr.write(`pgserve create-app: <slug> is required\n\n${USAGE}\n`);
    return 1;
  }
  const sanitized = sanitizeSlug(inputSlug);
  if (sanitized.length === 0) {
    process.stderr.write(
      `pgserve create-app: slug "${inputSlug}" sanitizes to empty; pick a slug `
      + 'with at least one alphanumeric character\n',
    );
    return 1;
  }

  const port = resolvePort(opts);
  const summary = {
    slug: sanitized,
    inputSlug,
    port,
    action: 'unknown',
  };

  // Step 1 — bootstrap the autopg_meta table.
  try {
    await ensureAutopgMetaSchema({ port });
  } catch (err) {
    process.stderr.write(`pgserve create-app: cannot bootstrap autopg_meta: ${err.message}\n`);
    summary.action = 'error';
    summary.error = err.message;
    if (opts.json) emit({ json: true, summary });
    return 2;
  }

  // Step 2 — look for an existing row.
  let existing;
  try {
    existing = selectAutopgMetaRow({ port, slug: sanitized });
  } catch (err) {
    process.stderr.write(`pgserve create-app: ${err.message}\n`);
    summary.action = 'error';
    summary.error = err.message;
    if (opts.json) emit({ json: true, summary });
    return 3;
  }

  const nowIso = new Date().toISOString();

  if (existing) {
    // Idempotent re-run path. Preserve `locked_roots` from the table
    // (do NOT re-snapshot live TRUSTED_IDENTITIES — BRIEF v5 A6 lock
    // preservation). Touch last_updated; rewrite the cache files.
    let writeResult;
    try {
      writeResult = bootstrapConsumerAdmin({
        slug: inputSlug,
        lockedRoots: existing.lockedRoots,
        createdAt: existing.createdAt,
        lastUpdated: nowIso,
      });
    } catch (err) {
      process.stderr.write(`pgserve create-app: failed to write cache files: ${err.message}\n`);
      summary.action = 'error';
      summary.error = err.message;
      if (opts.json) emit({ json: true, summary });
      return 1;
    }

    try {
      touchAutopgMetaRow({
        port,
        slug: sanitized,
        manifestPath: writeResult.manifestPath,
        nowIso,
      });
    } catch (err) {
      process.stderr.write(`pgserve create-app: ${err.message}\n`);
      summary.action = 'error';
      summary.error = err.message;
      if (opts.json) emit({ json: true, summary });
      return 3;
    }

    summary.action = 'touched';
    summary.createdAt = existing.createdAt;
    summary.lastUpdated = nowIso;
    summary.lockedRoots = existing.lockedRoots;
    summary.adminPath = writeResult.adminPath;
    summary.manifestPath = writeResult.manifestPath;
    emit({
      json: opts.json,
      summary,
      humanLines: [
        `pgserve create-app: slug "${sanitized}" already registered (touched).`,
        `  locked_roots preserved (${existing.lockedRoots.length} entries from createdAt=${existing.createdAt})`,
        `  admin:    ${writeResult.adminPath}`,
        `  manifest: ${writeResult.manifestPath}`,
      ],
    });
    return 0;
  }

  // Step 3 — fresh registration. Snapshot TRUSTED_IDENTITIES into the
  // table + cache files. The deep-clone strips Object.freeze wrappers
  // so the JSONB write is plain JSON.
  const lockedRoots = deepCloneRoots(TRUSTED_IDENTITIES);

  let writeResult;
  try {
    writeResult = bootstrapConsumerAdmin({
      slug: inputSlug,
      lockedRoots,
      createdAt: nowIso,
      lastUpdated: nowIso,
    });
  } catch (err) {
    process.stderr.write(`pgserve create-app: failed to write cache files: ${err.message}\n`);
    summary.action = 'error';
    summary.error = err.message;
    if (opts.json) emit({ json: true, summary });
    return 1;
  }

  try {
    insertAutopgMetaRow({
      port,
      slug: sanitized,
      manifestPath: writeResult.manifestPath,
      lockedRoots,
      nowIso,
    });
  } catch (err) {
    process.stderr.write(`pgserve create-app: ${err.message}\n`);
    summary.action = 'error';
    summary.error = err.message;
    if (opts.json) emit({ json: true, summary });
    return 3;
  }

  summary.action = 'created';
  summary.createdAt = nowIso;
  summary.lastUpdated = nowIso;
  summary.lockedRoots = lockedRoots;
  summary.adminPath = writeResult.adminPath;
  summary.manifestPath = writeResult.manifestPath;
  emit({
    json: opts.json,
    summary,
    humanLines: [
      `pgserve create-app: registered slug "${sanitized}".`,
      `  locked_roots: snapshotted ${lockedRoots.length} entries from TRUSTED_IDENTITIES`,
      `  admin:    ${writeResult.adminPath}`,
      `  manifest: ${writeResult.manifestPath}`,
    ],
  });
  return 0;
}

export const __testInternals = Object.freeze({
  parseFlags,
  resolvePort,
  deepCloneRoots,
});
