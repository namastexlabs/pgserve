/**
 * Settings writer — atomic, validated, chmod 0600, etag-aware.
 *
 * Public surface:
 *   - writeSettings(newSettings, { ifMatch?, settingsPath? })
 *       Validates, writes atomically (tmp + rename), chmod 0600, returns
 *       the new etag.
 *
 *   - setLeaf(key, value, { ifMatch? }) → convenience for `autopg config set`.
 *       Reads current settings, deep-merges the leaf, writes.
 *
 *   - removeExtra(gucName) → convenience for the UI's "delete row" action
 *       inside `postgres._extra`.
 *
 * Concurrency model:
 *   - On write: callers (UI helper) pass `ifMatch`. If the on-disk file
 *     etag has drifted, we throw EtagMismatchError so the caller can
 *     surface a "settings changed, reload?" banner instead of clobbering.
 *   - CLI is single-process and skips ifMatch (each `set` is its own
 *     transaction); callers may opt in by reading the loader etag first.
 *
 * File-mode invariant:
 *   - Every successful write leaves `settings.json` at mode 0600 on
 *     POSIX. On Windows, fs.chmodSync degrades gracefully (NTFS ACLs
 *     would be the proper equivalent, out of scope for v1).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA, SCHEMA_VERSION, buildDefaults } = require('./settings-schema.cjs');
const {
  ValidationError,
  EtagMismatchError,
  validateAll,
  validateSetting,
} = require('./settings-validator.cjs');
const {
  computeEtag,
  readSettingsFile,
  getConfigDir,
  getSettingsPath,
  loadEffectiveConfig,
} = require('./settings-loader.cjs');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Ensure the config directory exists with mode 0700. Idempotent.
 * 0700 (vs 0755 in the legacy install path) because it now contains
 * the password-bearing settings.json.
 */
function ensureConfigDir(configDir = getConfigDir()) {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
    return;
  }
  // Best-effort tighten if it was created loose by an earlier wave.
  try {
    fs.chmodSync(configDir, DIR_MODE);
  } catch {
    // Non-POSIX or unowned dir — fall through; the file's own 0600 is
    // the real defense.
  }
}

/**
 * Atomically write `bytes` to `targetPath`. Writes a sibling tmp file
 * (same dir so rename is atomic on Linux/macOS), chmods it, then
 * renames over the target.
 */
function atomicWrite(targetPath, bytes) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp.${process.pid}.${Date.now()}`);
  // mode here only affects POSIX. Windows ignores it; we re-chmod after rename anyway.
  fs.writeFileSync(tmp, bytes, { mode: FILE_MODE });
  // Some filesystems (Linux ext4) require an explicit chmod after writeFileSync
  // because umask can mask the mode bits.
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    // ignore on platforms that don't support chmod (Windows fallback)
  }
  fs.renameSync(tmp, targetPath);
  // Re-chmod after rename in case the filesystem didn't preserve mode
  // through the rename (rare but reported on some FUSE mounts).
  try {
    fs.chmodSync(targetPath, FILE_MODE);
  } catch {
    // ignore
  }
}

/**
 * Serialize the settings tree to deterministic JSON: section order
 * follows SCHEMA, fields within a section follow SCHEMA, unknown keys
 * (which validateAll already rejected) cannot appear here. Determinism
 * is what makes the etag stable across UI re-saves of unchanged
 * content.
 */
function serializeSettings(settings) {
  const orderedSections = Object.keys(SCHEMA);
  const out = { _schemaVersion: SCHEMA_VERSION };
  // Carry forward `_`-prefixed top-level metadata (e.g. `_migratedFrom`)
  // so migration markers and similar audit breadcrumbs survive a round-
  // trip through the writer. validateAll already ignores these keys.
  for (const [k, v] of Object.entries(settings)) {
    if (k.startsWith('_') && k !== '_schemaVersion') out[k] = v;
  }
  for (const section of orderedSections) {
    if (!settings[section]) continue;
    out[section] = {};
    for (const field of Object.keys(SCHEMA[section])) {
      if (field in settings[section]) {
        out[section][field] = settings[section][field];
      }
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Deep-merge `patch` into `base` (in place is fine since base is fresh
 * each call). Arrays are replaced wholesale (not concatenated). Used
 * to apply UI's partial PUT body on top of the current effective tree.
 */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/**
 * Drop schema-internal helper fields from a settings tree (e.g. the
 * `_schemaVersion` metadata we add on serialize) before re-validation.
 * Validator's "unknown key" check ignores `_`-prefixed top-level keys
 * but we strip on read for consistency.
 */
function stripMeta(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const { _schemaVersion, ...rest } = settings;
  void _schemaVersion;
  return rest;
}

/**
 * Read current parsed settings from disk (or {}) and compute the etag
 * the caller's `ifMatch` should be compared against.
 */
function readCurrent(settingsPath = getSettingsPath()) {
  const { raw, parsed } = readSettingsFile(settingsPath);
  return {
    parsed: stripMeta(parsed) || {},
    etag: computeEtag(raw),
  };
}

/**
 * Write the supplied (full) settings tree. Validates, atomically writes,
 * chmods 0600, returns `{ etag }` of the new file. Throws ValidationError
 * on shape/validation failure or EtagMismatchError on concurrency clash.
 *
 * `ifMatch` semantics:
 *   - undefined → caller doesn't care (CLI). Skip the check.
 *   - string    → compare against current on-disk etag; mismatch throws.
 */
function writeSettings(newSettings, { ifMatch, settingsPath = getSettingsPath() } = {}) {
  if (!newSettings || typeof newSettings !== 'object') {
    throw new ValidationError('INVALID_TYPE', '_root', 'expected object');
  }

  // Concurrency check first so we don't waste validation work when
  // there's a race.
  if (ifMatch !== undefined) {
    const { etag: currentEtag } = readCurrent(settingsPath);
    if (currentEtag !== ifMatch) {
      throw new EtagMismatchError(currentEtag, ifMatch);
    }
  }

  // Always validate the post-merge tree, not the patch — gives us a
  // single source of truth for "what's about to land on disk".
  const merged = stripMeta(newSettings);
  validateAll(merged);

  ensureConfigDir(path.dirname(settingsPath));
  const bytes = serializeSettings(merged);
  atomicWrite(settingsPath, bytes);

  return { etag: computeEtag(Buffer.from(bytes, 'utf8')) };
}

/**
 * Read current settings, apply a single-leaf update, and write back.
 * Used by `autopg config set` and by validateSetting-aware UI flows.
 *
 * Supports:
 *   - section.field            (curated leaf)
 *   - postgres._extra.<gucName> (extra-entry; sets/replaces)
 */
function setLeaf(key, value, { ifMatch, settingsPath = getSettingsPath() } = {}) {
  // Validate first so we never partially mutate on a bad input.
  const { value: validated } = validateSetting(key, value);

  // Read current settings tree (file-only, no env merge — the file is
  // what we're editing). Defaults backfill missing sections so nesting
  // works on a fresh install.
  const { parsed: current } = readCurrent(settingsPath);
  const baseline = buildDefaults();
  const tree = deepMerge(baseline, current);

  if (key.startsWith('postgres._extra.')) {
    const gucName = key.slice('postgres._extra.'.length);
    if (!tree.postgres) tree.postgres = {};
    if (!tree.postgres._extra) tree.postgres._extra = {};
    tree.postgres._extra[gucName] = validated;
  } else {
    const [section, field] = key.split('.');
    if (!tree[section]) tree[section] = {};
    tree[section][field] = validated;
  }

  return writeSettings(tree, { ifMatch, settingsPath });
}

/**
 * Remove a key from `postgres._extra`. No-op if missing. Returns
 * `{ etag }` of the new file (or current etag if no change was needed).
 */
function removeExtra(gucName, { ifMatch, settingsPath = getSettingsPath() } = {}) {
  const { parsed: current } = readCurrent(settingsPath);
  const tree = deepMerge(buildDefaults(), current);
  if (tree.postgres?._extra && gucName in tree.postgres._extra) {
    delete tree.postgres._extra[gucName];
    return writeSettings(tree, { ifMatch, settingsPath });
  }
  return { etag: readCurrent(settingsPath).etag };
}

/**
 * Initialize `settings.json` with schema defaults. Refuses to clobber
 * an existing file unless `force: true`. Used by `autopg config init`.
 */
function initSettings({ force = false, settingsPath = getSettingsPath() } = {}) {
  if (fs.existsSync(settingsPath) && !force) {
    const err = new Error(
      `${settingsPath} already exists; pass force=true to overwrite`,
    );
    err.code = 'EEXIST';
    throw err;
  }
  return writeSettings(buildDefaults(), { settingsPath });
}

module.exports = {
  writeSettings,
  setLeaf,
  removeExtra,
  initSettings,
  ensureConfigDir,
  serializeSettings,
  FILE_MODE,
  DIR_MODE,
  // Test surface
  _internals: {
    atomicWrite,
    deepMerge,
    stripMeta,
    readCurrent,
    loadEffectiveConfig,
  },
};
