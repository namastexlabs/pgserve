/**
 * `autopg config` subcommand router (also reachable via `pgserve config`).
 *
 * Surface:
 *   autopg config list                    - print every leaf as key|value|source
 *   autopg config get <key>               - print the resolved value (machine-friendly)
 *   autopg config set <key> <value>       - validate + atomic write, round-trips through get
 *   autopg config edit                    - open $EDITOR on settings.json
 *   autopg config path                    - print absolute path to settings.json
 *   autopg config init [--force]          - write schema defaults; refuses to clobber
 *
 * Exit codes:
 *   0 - success
 *   1 - unknown subcommand / IO error / EDITOR not set / settings file unreadable
 *   2 - validation error (stable shape: `error: <field> — <CODE>: <detail>`)
 *
 * The CLI is single-process and skips the etag round-trip — each `set` is its
 * own transaction. Concurrency control is the UI helper's responsibility.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const { loadEffectiveConfig, getSettingsPath } = require('./settings-loader.cjs');
const {
  setLeaf,
  initSettings,
  ensureConfigDir,
} = require('./settings-writer.cjs');
const {
  ValidationError,
  validateSetting,
  resolveKey,
} = require('./settings-validator.cjs');
const { SCHEMA, flattenSchema } = require('./settings-schema.cjs');

const EXIT_OK = 0;
const EXIT_UNKNOWN = 1;
const EXIT_VALIDATION = 2;

function emitError(field, code, detail) {
  process.stderr.write(`error: ${field} — ${code}: ${detail}\n`);
}

function emitErrorFromValidation(err) {
  emitError(err.field ?? '_root', err.code ?? 'INVALID', err.detail ?? err.message);
}

/**
 * Resolve the current value of `key` from the merged effective config tree.
 * Supports curated leaves (`section.field`) and `_extra` entries
 * (`postgres._extra.<gucName>`). Returns `{ value }` or `null` when missing.
 */
function readValue(tree, key) {
  if (key.startsWith('postgres._extra.')) {
    const guc = key.slice('postgres._extra.'.length);
    const map = tree?.postgres?._extra;
    if (map && Object.prototype.hasOwnProperty.call(map, guc)) {
      return { value: map[guc] };
    }
    return null;
  }
  const [section, field] = key.split('.');
  if (!section || !field) return null;
  const node = tree?.[section];
  if (!node || !Object.prototype.hasOwnProperty.call(node, field)) return null;
  return { value: node[field] };
}

/**
 * Serialize a leaf value for human consumption. Objects (the `_extra` map
 * descriptor) round-trip through JSON; primitives stringify directly.
 * `null` / `undefined` render as the empty string so `autopg config get`
 * stays scriptable.
 */
function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Assemble the full set of keys to display in `config list`. Curated
 * leaves come from the schema; `_extra` entries are expanded from the
 * effective tree so user-added GUCs surface.
 */
function enumerateKeys(tree) {
  const out = [];
  for (const [section, fields] of Object.entries(SCHEMA)) {
    for (const field of Object.keys(fields)) {
      out.push(`${section}.${field}`);
    }
  }
  const extras = tree?.postgres?._extra;
  if (extras && typeof extras === 'object') {
    for (const guc of Object.keys(extras)) {
      out.push(`postgres._extra.${guc}`);
    }
  }
  return out;
}

function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function cmdList() {
  const { settings, sources } = loadEffectiveConfig();
  const keys = enumerateKeys(settings);

  // Source for `_extra` entries inherits the parent map's source. The
  // loader doesn't break the map per-entry because env precedence
  // applies wholesale, so we surface each row's source as the parent.
  const rows = keys.map((key) => {
    const valueResolved = readValue(settings, key);
    const value = valueResolved ? formatValue(valueResolved.value) : '';
    let source;
    if (key.startsWith('postgres._extra.')) {
      source = sources['postgres._extra'] || 'default';
    } else {
      source = sources[key] || 'default';
    }
    return { key, value, source };
  });

  const widths = {
    key: Math.max(3, ...rows.map((r) => r.key.length)),
    value: Math.max(5, ...rows.map((r) => r.value.length)),
    source: Math.max(6, ...rows.map((r) => r.source.length)),
  };

  process.stdout.write(
    `${pad('KEY', widths.key)}  ${pad('VALUE', widths.value)}  ${pad('SOURCE', widths.source)}\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${pad(row.key, widths.key)}  ${pad(row.value, widths.value)}  ${pad(row.source, widths.source)}\n`,
    );
  }
  return EXIT_OK;
}

function cmdGet(args) {
  const key = args[0];
  if (!key) {
    emitError('_args', 'INVALID_KEY', 'config get requires a key');
    return EXIT_VALIDATION;
  }
  // Validate key shape early so typos surface as INVALID_KEY rather than
  // an empty value print.
  try {
    resolveKey(key);
  } catch (err) {
    if (err instanceof ValidationError) {
      emitErrorFromValidation(err);
      return EXIT_VALIDATION;
    }
    throw err;
  }

  const { settings } = loadEffectiveConfig();
  const resolved = readValue(settings, key);
  if (!resolved) {
    process.stdout.write('\n');
    return EXIT_OK;
  }
  process.stdout.write(`${formatValue(resolved.value)}\n`);
  return EXIT_OK;
}

function cmdSet(args) {
  if (args.length < 2) {
    emitError('_args', 'INVALID_KEY', 'config set requires <key> <value>');
    return EXIT_VALIDATION;
  }
  const [key, ...rest] = args;
  // Allow values that contain spaces by joining the remainder. Operators
  // can still quote the value as a single argv slot; this is the safe
  // fallback.
  const value = rest.join(' ');

  try {
    setLeaf(key, value);
  } catch (err) {
    if (err instanceof ValidationError) {
      emitErrorFromValidation(err);
      return EXIT_VALIDATION;
    }
    throw err;
  }
  return EXIT_OK;
}

function cmdPath() {
  process.stdout.write(`${getSettingsPath()}\n`);
  return EXIT_OK;
}

function cmdInit(args) {
  const force = args.includes('--force');
  ensureConfigDir();
  try {
    initSettings({ force });
  } catch (err) {
    if (err.code === 'EEXIST') {
      emitError(
        getSettingsPath(),
        'EEXIST',
        'settings.json already exists; pass --force to overwrite',
      );
      return EXIT_VALIDATION;
    }
    if (err instanceof ValidationError) {
      emitErrorFromValidation(err);
      return EXIT_VALIDATION;
    }
    throw err;
  }
  process.stdout.write(`autopg: wrote defaults to ${getSettingsPath()}\n`);
  return EXIT_OK;
}

/**
 * `autopg config edit` — open the configured editor on `settings.json`,
 * creating the file with defaults if it doesn't exist yet (so the
 * operator gets a useful template instead of an empty buffer).
 *
 * Editor resolution: $VISUAL, $EDITOR, then `vi` (POSIX) / `notepad` (Windows).
 */
function cmdEdit() {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    ensureConfigDir();
    initSettings({});
  }

  const editor =
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === 'win32' ? 'notepad' : 'vi');

  // Editors are interactive — inherit stdio so the operator gets the TUI.
  const result = spawnSync(editor, [settingsPath], { stdio: 'inherit' });
  if (result.error) {
    emitError(
      'editor',
      'EEDITOR',
      `failed to launch editor "${editor}": ${result.error.message}`,
    );
    return EXIT_UNKNOWN;
  }
  return result.status ?? EXIT_OK;
}

/**
 * Subcommand dispatch. Returns the exit code; the parent dispatcher
 * uses the return value as `process.exit(code)` directly.
 */
function dispatch(subcommand, args = []) {
  switch (subcommand) {
    case 'list':
      return cmdList();
    case 'get':
      return cmdGet(args);
    case 'set':
      return cmdSet(args);
    case 'path':
      return cmdPath();
    case 'init':
      return cmdInit(args);
    case 'edit':
      return cmdEdit();
    case undefined:
    case '': {
      // Bare `autopg config` → list (mirrors `git config --list` ergonomics).
      return cmdList();
    }
    default:
      emitError(subcommand, 'INVALID_KEY', `unknown config subcommand "${subcommand}"`);
      process.stderr.write(
        'usage: autopg config <list|get|set|edit|path|init> [args]\n',
      );
      return EXIT_UNKNOWN;
  }
}

module.exports = {
  dispatch,
  EXIT_OK,
  EXIT_UNKNOWN,
  EXIT_VALIDATION,
  // Test surface
  _internals: {
    cmdList,
    cmdGet,
    cmdSet,
    cmdPath,
    cmdInit,
    cmdEdit,
    enumerateKeys,
    formatValue,
    readValue,
    flattenSchema,
    validateSetting,
  },
};
