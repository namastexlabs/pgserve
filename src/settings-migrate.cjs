/**
 * One-shot migration from `~/.pgserve/` to `~/.autopg/`.
 *
 * Trigger: dispatcher pre-flight on every CLI entry point.
 * Behavior:
 *   - If `~/.autopg/` already exists OR `~/.pgserve/` does not exist → no-op.
 *   - Else: copy the legacy directory contents to `~/.autopg/` preserving
 *     mtimes, then drop `MIGRATED-FROM-PGSERVE.md` in the old dir as the
 *     idempotency marker.
 *   - Skips if the marker already exists, even if the new dir was later
 *     deleted (so the migration is permanent — operators who want to redo
 *     it must remove the marker manually).
 *
 * The legacy dir is left in place (not removed) so operators can A/B and
 * roll back if anything goes wrong. This is intentional: this code runs
 * unattended on every `autopg <subcommand>` invocation, so we err on the
 * side of preserving the user's data.
 *
 * The migration also normalizes the legacy `config.json` (just port +
 * dataDir + registeredAt) into the new `settings.json` shape: the legacy
 * fields populate `server.port` and `runtime.dataDir`, everything else is
 * filled with defaults.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDefaults, SCHEMA_VERSION } = require('./settings-schema.cjs');
const { serializeSettings } = require('./settings-writer.cjs');

const MARKER_FILENAME = 'MIGRATED-FROM-PGSERVE.md';
const MARKER_BODY = `# Migrated to ~/.autopg/

This directory has been migrated to \`~/.autopg/\` as part of the
soft-rename to autopg. Settings, data, and logs were copied verbatim;
the legacy location is preserved so you can roll back if needed.

To complete the cutover (after verifying autopg works):

    rm -rf ~/.pgserve

This file is the migration's idempotency marker — its presence prevents
re-migration on subsequent autopg invocations.
`;

/**
 * Resolve the legacy and new config directories.
 *
 * Migration only runs against the *default* `~/.pgserve` → `~/.autopg`
 * pair. When the user has either env override set, they're in
 * custom-config-dir mode (CI, tests, multi-instance setups) and we
 * never auto-migrate — that's a foot-gun. Operators in custom mode
 * who want to migrate can:
 *
 *   1. unset AUTOPG_CONFIG_DIR/PGSERVE_CONFIG_DIR
 *   2. run `autopg config init`
 *   3. copy whatever they need by hand
 *
 * The override-skip path is the reason `legacy`/`fresh` may be null
 * here; `migrateIfNeeded` short-circuits in that case.
 *
 * Tests opt in to the default-path flow by passing an explicit `home`
 * (a tempdir) instead of relying on env vars.
 */
function resolveDirs({ home = os.homedir(), env = process.env, allowOverrides = false } = {}) {
  if (!allowOverrides && (env.AUTOPG_CONFIG_DIR || env.PGSERVE_CONFIG_DIR)) {
    return { legacy: null, fresh: null, skipped: true };
  }
  const legacy = path.join(home, '.pgserve');
  const fresh = path.join(home, '.autopg');
  return { legacy, fresh };
}

/**
 * Recursively copy `src` to `dest` preserving mtimes. Skips the marker
 * file (so a re-migration after marker removal doesn't carry it over)
 * and skips any path under `dest` that already exists (we never
 * overwrite during migration).
 */
function copyTree(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  for (const entry of entries) {
    if (entry.name === MARKER_FILENAME) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(srcPath, destPath);
    } else if (entry.isFile()) {
      if (fs.existsSync(destPath)) continue;
      fs.copyFileSync(srcPath, destPath);
      const stat = fs.statSync(srcPath);
      try {
        fs.utimesSync(destPath, stat.atime, stat.mtime);
      } catch {
        // best-effort; don't fail migration over an mtime preserve hiccup
      }
    }
    // Symlinks / sockets are skipped; the legacy dir never contains them.
  }
}

/**
 * Translate the legacy `config.json` shape ({ port, dataDir, registeredAt })
 * into the new `settings.json` shape, filling everything else with defaults.
 *
 * Returns the serialized JSON string ready to write.
 */
function buildSettingsFromLegacyConfig(legacyConfig) {
  const tree = buildDefaults();
  if (legacyConfig && typeof legacyConfig === 'object') {
    if (Number.isInteger(legacyConfig.port)) {
      tree.server.port = legacyConfig.port;
    }
    if (typeof legacyConfig.dataDir === 'string' && legacyConfig.dataDir.length) {
      tree.runtime.dataDir = legacyConfig.dataDir;
    }
  }
  // Marker the migration even within the file payload so a future
  // dump-with-context tool can identify it.
  tree._migratedFrom = '~/.pgserve';
  tree._schemaVersion = SCHEMA_VERSION;
  return serializeSettings(tree);
}

/**
 * Run the migration. Idempotent — safe to call from the dispatcher
 * pre-flight on every command. Returns `{ migrated: bool, reason }`
 * for callers (and tests) that want to log the outcome.
 */
function migrateIfNeeded(opts = {}) {
  const dirs = resolveDirs(opts);
  if (dirs.skipped) {
    return { migrated: false, reason: 'env-override-set', ...dirs };
  }
  const { legacy, fresh } = dirs;
  const markerPath = path.join(legacy, MARKER_FILENAME);

  if (!fs.existsSync(legacy)) {
    return { migrated: false, reason: 'no-legacy-dir', legacy, fresh };
  }
  if (fs.existsSync(markerPath)) {
    return { migrated: false, reason: 'already-migrated', legacy, fresh };
  }
  if (fs.existsSync(fresh)) {
    // Both exist, no marker — operator may have created `~/.autopg/`
    // independently. Don't touch either; leave the marker in place so
    // we don't try again.
    fs.writeFileSync(markerPath, MARKER_BODY, { mode: 0o644 });
    return { migrated: false, reason: 'both-exist-marker-set', legacy, fresh };
  }

  // Copy the directory tree first so any failure leaves the legacy
  // dir untouched.
  copyTree(legacy, fresh);

  // Translate config.json → settings.json if present and the new file
  // wasn't already created via copyTree (which would have copied any
  // existing settings.json verbatim).
  const legacyConfigPath = path.join(legacy, 'config.json');
  const freshSettingsPath = path.join(fresh, 'settings.json');
  if (fs.existsSync(legacyConfigPath) && !fs.existsSync(freshSettingsPath)) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(legacyConfigPath, 'utf8'));
    } catch {
      parsed = null;
    }
    const bytes = buildSettingsFromLegacyConfig(parsed);
    fs.writeFileSync(freshSettingsPath, bytes, { mode: 0o600 });
    try {
      fs.chmodSync(freshSettingsPath, 0o600);
    } catch {
      // ignore on platforms without chmod support
    }
  }

  fs.writeFileSync(markerPath, MARKER_BODY, { mode: 0o644 });
  return { migrated: true, reason: 'copied', legacy, fresh };
}

module.exports = {
  migrateIfNeeded,
  resolveDirs,
  buildSettingsFromLegacyConfig,
  MARKER_FILENAME,
  MARKER_BODY,
  // Test surface
  _internals: {
    copyTree,
  },
};
