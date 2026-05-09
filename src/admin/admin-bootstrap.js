/**
 * Per-consumer admin + manifest bootstrap.
 *
 * pgserve singleton (v2.6) — `autopg-distribution-cutover-finalize`
 * wish, Group 3 (`pgserve create-app` + manifest LOCK 1) deliverable D2.
 *
 * Writes two files to disk for a registered consumer:
 *
 *   ~/.autopg/<sanitized-slug>/admin.json    (mode 0600)
 *   ~/.autopg/<sanitized-slug>/manifest.json (mode 0600)
 *
 * The containing directory is `0700`. Both files are derived caches of
 * the authoritative `autopg_meta` row; cache-recovery (when divergence
 * is detected by future doctor surfaces) is the V1 manual story:
 * operator deletes the per-consumer dir + re-runs `pgserve create-app
 * <slug>` (idempotent; preserves `locked_roots` from the table).
 *
 * Schema:
 *
 *   admin.json      { slug, manifestPath, lockedRoots: [...],
 *                     createdAt, lastUpdated }
 *
 *   manifest.json   { schemaVersion: 1, slug, lockedRoots: [...],
 *                     createdAt, lastUpdated }
 *
 *   The two files share the `slug` + `lockedRoots` fields by design —
 *   admin.json is the orchestrator-facing record, manifest.json is the
 *   verifier-facing copy with an explicit `schemaVersion` for future
 *   migrations.
 *
 * Orthogonality: this per-consumer admin.json sits ONE directory level
 * deeper than the host-level `~/.autopg/admin.json` (owned by
 * `canonical-pgserve-pm2-supervision` G1, src/lib/admin-json.js). They
 * never collide; the host record is `~/.autopg/admin.json`, the
 * per-consumer record is `~/.autopg/<slug>/admin.json`.
 *
 * Slug sanitization: REUSES `sanitizeSlug` from
 * src/provision/db-naming.js — the same canonical helper used to build
 * provision database/role names. This guarantees the per-consumer dir
 * for `@demo/app` resolves to `~/.autopg/demo_app/`, matching whatever
 * provision/gc derived from the same input.
 *
 * TOCTOU defense: after mkdir, the resolved path is verified to still
 * land inside the canonical autopg root via `fs.realpathSync` — refuses
 * to write through a symlink that points outside `~/.autopg/`. The
 * file writes themselves use the standard tmp + rename + chmod pattern
 * already in src/lib/admin-json.js.
 */

import fs from 'fs';
import path from 'path';

import { sanitizeSlug } from '../provision/db-naming.js';
import { getDefaultConfigDir } from '../lib/admin-json.js';

export const PER_CONSUMER_ADMIN_FILE = 'admin.json';
export const PER_CONSUMER_MANIFEST_FILE = 'manifest.json';
export const PER_CONSUMER_FILE_MODE = 0o600;
export const PER_CONSUMER_DIR_MODE = 0o700;
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Resolve the per-consumer config directory for a given slug.
 *
 * `<configDir>/<sanitized-slug>` — defaults `<configDir>` to whatever
 * `getDefaultConfigDir()` returns (`AUTOPG_CONFIG_DIR` >
 * `PGSERVE_CONFIG_DIR` > `$HOME/.autopg`).
 *
 * Throws on empty/whitespace slug input — never silently coerce a bad
 * slug to a flat path that would clobber the host-level admin.json or
 * an unrelated consumer.
 */
export function getConsumerDir(slug, { configDir = getDefaultConfigDir() } = {}) {
  if (typeof slug !== 'string' || slug.trim().length === 0) {
    throw new TypeError('admin-bootstrap: slug must be a non-empty string');
  }
  const sanitized = sanitizeSlug(slug);
  if (sanitized.length === 0) {
    throw new TypeError(
      `admin-bootstrap: slug "${slug}" sanitizes to empty; pick a slug `
      + 'with at least one alphanumeric character',
    );
  }
  return {
    sanitized,
    consumerDir: path.join(configDir, sanitized),
    configDir,
  };
}

export function getConsumerAdminPath(slug, opts) {
  const { consumerDir } = getConsumerDir(slug, opts);
  return path.join(consumerDir, PER_CONSUMER_ADMIN_FILE);
}

export function getConsumerManifestPath(slug, opts) {
  const { consumerDir } = getConsumerDir(slug, opts);
  return path.join(consumerDir, PER_CONSUMER_MANIFEST_FILE);
}

function ensureConfigRoot(configDir) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: PER_CONSUMER_DIR_MODE });
  }
}

function ensureConsumerDir(configDir, consumerDir) {
  ensureConfigRoot(configDir);
  if (!fs.existsSync(consumerDir)) {
    fs.mkdirSync(consumerDir, { recursive: true, mode: PER_CONSUMER_DIR_MODE });
  }
  // TOCTOU defense: refuse to write through a symlink that escapes the
  // canonical config root. Resolve both the root and the consumer dir
  // and assert containment.
  let realRoot;
  let realConsumer;
  try {
    realRoot = fs.realpathSync(configDir);
    realConsumer = fs.realpathSync(consumerDir);
  } catch (err) {
    throw new Error(
      `admin-bootstrap: failed to resolve real path for "${consumerDir}": ${err.message}`,
    );
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realConsumer !== realRoot && !realConsumer.startsWith(rootWithSep)) {
    const err = new Error(
      `admin-bootstrap: refusing to write — "${consumerDir}" resolves to `
      + `"${realConsumer}", which is outside config root "${realRoot}". `
      + 'Possible symlink attack; remove the symlink and retry.',
    );
    err.code = 'EAUTOPGCONSUMERESCAPE';
    err.consumerDir = consumerDir;
    err.realConsumer = realConsumer;
    err.configRoot = realRoot;
    throw err;
  }
  fs.chmodSync(consumerDir, PER_CONSUMER_DIR_MODE);
  return realConsumer;
}

function atomicWrite(filePath, body) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: PER_CONSUMER_FILE_MODE });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, PER_CONSUMER_FILE_MODE);
}

function jsonBody(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function deepCloneRoots(lockedRoots) {
  if (!Array.isArray(lockedRoots)) {
    throw new TypeError('admin-bootstrap: lockedRoots must be an array');
  }
  // Use JSON round-trip to drop any Object.freeze wrappers AND defensively
  // copy nested fields. TRUSTED_IDENTITIES entries are plain objects with
  // string values — no Date / Buffer / function / undefined that would
  // round-trip badly.
  return JSON.parse(JSON.stringify(lockedRoots));
}

/**
 * Compose the on-disk records for a consumer. Pure function — no fs.
 *
 * Used by `bootstrapConsumerAdmin` (which writes them) and by the
 * doctor surface (which compares against on-disk + table state).
 */
export function buildConsumerRecords({ slug, lockedRoots, createdAt, lastUpdated, configDir }) {
  const { sanitized, consumerDir } = getConsumerDir(slug, { configDir });
  const manifestPath = path.join(consumerDir, PER_CONSUMER_MANIFEST_FILE);
  const cloned = deepCloneRoots(lockedRoots);

  const adminRecord = {
    slug: sanitized,
    manifestPath,
    lockedRoots: cloned,
    createdAt,
    lastUpdated,
  };

  const manifestRecord = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    slug: sanitized,
    lockedRoots: cloned,
    createdAt,
    lastUpdated,
  };

  return {
    consumerDir,
    sanitized,
    manifestPath,
    adminRecord,
    manifestRecord,
  };
}

/**
 * Write the per-consumer admin.json + manifest.json pair.
 *
 * Inputs:
 *   - slug         the input slug (will be sanitized via sanitizeSlug)
 *   - lockedRoots  array of TRUSTED_IDENTITIES-shaped entries (frozen
 *                  at create-app time); deep-cloned before write
 *   - createdAt    ISO 8601 string; on first create-app
 *   - lastUpdated  ISO 8601 string; touched every create-app re-run
 *
 * Idempotent: callers that re-run `pgserve create-app <slug>` should
 * leave `createdAt` untouched (read it back from the autopg_meta row,
 * not regenerated) and only refresh `lastUpdated`. The verb in D3
 * threads this through.
 *
 * Returns the written records + paths so the caller can echo them in
 * logs or feed them to a downstream reporter.
 */
export function bootstrapConsumerAdmin({
  slug,
  lockedRoots,
  createdAt,
  lastUpdated,
  configDir = getDefaultConfigDir(),
} = {}) {
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new TypeError('admin-bootstrap: createdAt must be a non-empty ISO 8601 string');
  }
  if (typeof lastUpdated !== 'string' || lastUpdated.length === 0) {
    throw new TypeError('admin-bootstrap: lastUpdated must be a non-empty ISO 8601 string');
  }

  const { sanitized, consumerDir, adminRecord, manifestRecord } =
    buildConsumerRecords({ slug, lockedRoots, createdAt, lastUpdated, configDir });

  const realConsumerDir = ensureConsumerDir(configDir, consumerDir);
  // Recompute the manifest path to live under the resolved real dir so
  // the manifestPath stored in admin.json matches what we actually
  // wrote, even if the consumerDir we computed above was a symlink
  // alias of the canonical realConsumerDir.
  const adminFilePath = path.join(realConsumerDir, PER_CONSUMER_ADMIN_FILE);
  const manifestFilePath = path.join(realConsumerDir, PER_CONSUMER_MANIFEST_FILE);
  adminRecord.manifestPath = manifestFilePath;

  atomicWrite(manifestFilePath, jsonBody(manifestRecord));
  atomicWrite(adminFilePath, jsonBody(adminRecord));

  return {
    sanitized,
    consumerDir: realConsumerDir,
    adminPath: adminFilePath,
    manifestPath: manifestFilePath,
    adminRecord,
    manifestRecord,
  };
}

/**
 * Read the consumer admin.json. Returns the parsed object on success,
 * `null` when the file is missing or unreadable. Mirrors the read
 * semantics of `readAdminJson` in src/lib/admin-json.js — never throws
 * on missing/broken file.
 */
export function readConsumerAdmin(slug, { configDir = getDefaultConfigDir() } = {}) {
  const file = getConsumerAdminPath(slug, { configDir });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the consumer manifest.json. Same semantics as readConsumerAdmin.
 */
export function readConsumerManifest(slug, { configDir = getDefaultConfigDir() } = {}) {
  const file = getConsumerManifestPath(slug, { configDir });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}
