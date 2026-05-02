/**
 * Settings loader — reads `~/.autopg/settings.json`, merges defaults < file
 * < env, returns `{ settings, sources, etag }`.
 *
 * Precedence:
 *   default  (lowest)  — from settings-schema.js
 *   file               — `~/.autopg/settings.json` (or AUTOPG_CONFIG_DIR override)
 *   env      (highest) — process.env.AUTOPG_<X> beats process.env.PGSERVE_<X>
 *
 * `sources` is a flat map of dotted keys → 'default' | 'file' | 'env:<NAME>'.
 * `etag` is sha256 of the raw file bytes (or 'sha256:empty' when no file
 * exists). Deterministic for unchanged files, used for optimistic
 * concurrency control on the UI helper's PUT path.
 *
 * The PGSERVE_<X>-only fall-through path emits a one-time deprecation
 * note via `logger.warn` (suppressed on subsequent calls within the
 * same process).
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SCHEMA, buildDefaults } = require('./settings-schema.cjs');

const SETTINGS_FILENAME = 'settings.json';
const EMPTY_FILE_ETAG = 'sha256:empty';

let _legacyEnvWarningEmitted = false;

/**
 * Where settings.json lives. AUTOPG_CONFIG_DIR wins over PGSERVE_CONFIG_DIR
 * (the legacy var) which wins over the default `~/.autopg/`.
 *
 * NOTE: when only PGSERVE_CONFIG_DIR is set we fall back to `~/.pgserve/`
 * (the legacy directory), not `~/.autopg/`. This is the migration-bridge
 * path so existing operators keep working until they migrate. The migrate
 * helper is what decouples the two.
 */
function getConfigDir() {
  if (process.env.AUTOPG_CONFIG_DIR) return process.env.AUTOPG_CONFIG_DIR;
  if (process.env.PGSERVE_CONFIG_DIR) return process.env.PGSERVE_CONFIG_DIR;
  return path.join(os.homedir(), '.autopg');
}

function getSettingsPath() {
  return path.join(getConfigDir(), SETTINGS_FILENAME);
}

/**
 * Read raw file bytes and parse JSON. Returns `{ raw, parsed }` where
 * `raw` is the bytes used to compute the etag and `parsed` is the JSON
 * tree. Returns `{ raw: null, parsed: null }` when the file is missing.
 *
 * Throws SyntaxError when the file exists but doesn't parse — callers
 * (CLI dispatch) should surface the path so operators can fix or
 * re-init.
 */
function readSettingsFile(settingsPath = getSettingsPath()) {
  if (!fs.existsSync(settingsPath)) return { raw: null, parsed: null };
  const raw = fs.readFileSync(settingsPath);
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return { raw, parsed };
  } catch (err) {
    const wrapped = new SyntaxError(
      `Failed to parse ${settingsPath}: ${err.message}`,
    );
    wrapped.cause = err;
    wrapped.path = settingsPath;
    throw wrapped;
  }
}

/**
 * Compute sha256 etag of the raw file bytes. Stable for unchanged
 * files. `EMPTY_FILE_ETAG` for the missing-file case so callers can
 * still pass an `If-Match` (and a CLI write that creates the file
 * round-trips deterministically).
 */
function computeEtag(rawBytes) {
  if (!rawBytes || rawBytes.length === 0) return EMPTY_FILE_ETAG;
  const hash = crypto.createHash('sha256').update(rawBytes).digest('hex');
  return `sha256:${hash}`;
}

/**
 * Cast an env var string into the descriptor's runtime type. Mirrors
 * `coerce` in settings-validator but without throwing — env vars are
 * trusted by definition (the operator set them) and any garbage value
 * surfaces at runtime via the validator on the next write.
 */
function castEnv(descriptor, raw) {
  switch (descriptor.type) {
    case 'int': {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : descriptor.default;
    }
    case 'bool': {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return descriptor.default;
    }
    default:
      return raw;
  }
}

/**
 * Pick the env var that wins for a leaf, in priority order. Returns
 * `{ envName, raw }` on hit, `null` on miss.
 *
 * The first AUTOPG_<X> that is set wins outright. Falling through to
 * a PGSERVE_<X>-only setting trips the one-time deprecation note.
 */
function resolveEnv(descriptor, env, logger) {
  if (!Array.isArray(descriptor.env) || descriptor.env.length === 0) return null;
  for (const name of descriptor.env) {
    if (env[name] !== undefined && env[name] !== '') {
      const isLegacy = name.startsWith('PGSERVE_');
      if (isLegacy && !_legacyEnvWarningEmitted) {
        _legacyEnvWarningEmitted = true;
        logger?.warn?.(
          { env: name },
          `${name} is deprecated; prefer ${descriptor.env[0]}`,
        );
      }
      return { envName: name, raw: env[name] };
    }
  }
  return null;
}

/**
 * Merge defaults < file < env, building up `sources` in lockstep so
 * each leaf's origin is recorded. `postgres._extra` is treated
 * specially: file value wins as a whole map (no per-key env overrides).
 */
function mergeWithSources({ defaults, fileSettings, env, logger, schema = SCHEMA }) {
  const settings = {};
  const sources = {};

  for (const [section, fields] of Object.entries(schema)) {
    settings[section] = {};
    for (const [field, descriptor] of Object.entries(fields)) {
      const dotted = `${section}.${field}`;
      let value = clone(descriptor.default);
      let source = 'default';

      const fileSection = fileSettings && fileSettings[section];
      if (fileSection && Object.prototype.hasOwnProperty.call(fileSection, field)) {
        value = clone(fileSection[field]);
        source = 'file';
      }

      const envHit = resolveEnv(descriptor, env, logger);
      if (envHit) {
        value = castEnv(descriptor, envHit.raw);
        source = `env:${envHit.envName}`;
      }

      settings[section][field] = value;
      sources[dotted] = source;
    }
  }
  return { settings, sources };
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = clone(v);
  return out;
}

/**
 * Load + merge entry point. Returns `{ settings, sources, etag, path }`.
 *
 * `logger` is optional — when omitted, deprecation notes go to
 * stderr via console.warn so the CLI surface still has visibility.
 *
 * `env` defaults to process.env so callers can inject a frozen snapshot
 * for tests.
 */
function loadEffectiveConfig({
  schema = SCHEMA,
  env = process.env,
  logger,
  settingsPath = getSettingsPath(),
} = {}) {
  const fallbackLogger = logger || {
    warn: (data, msg) => console.warn(`[autopg] ${msg ?? ''} ${JSON.stringify(data ?? {})}`),
  };
  const { raw, parsed } = readSettingsFile(settingsPath);
  const defaults = buildDefaults(schema);
  const { settings, sources } = mergeWithSources({
    defaults,
    fileSettings: parsed,
    env,
    logger: fallbackLogger,
    schema,
  });
  const etag = computeEtag(raw);
  return { settings, sources, etag, path: settingsPath };
}

/**
 * Test helper: reset the once-flag so multiple test cases can each
 * observe the deprecation log line.
 */
function resetLegacyEnvWarning() {
  _legacyEnvWarningEmitted = false;
}

module.exports = {
  loadEffectiveConfig,
  computeEtag,
  readSettingsFile,
  getConfigDir,
  getSettingsPath,
  EMPTY_FILE_ETAG,
  SETTINGS_FILENAME,
  // Test surface
  _internals: {
    castEnv,
    resolveEnv,
    mergeWithSources,
    resetLegacyEnvWarning,
  },
};
