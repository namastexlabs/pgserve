/**
 * Build PostgreSQL `-c key=value` arg pairs from a settings tree.
 *
 * Boot-time policy is "drop + warn": invalid GUC entries (curated or
 * `_extra`) are skipped and the offending entry is logged via
 * `logger.warn`. Postgres itself is the final validator for value
 * semantics — we only enforce the structural invariants that the
 * settings-validator already guarantees on write (GUC name regex +
 * scalar value safety).
 *
 * Curated keys win over `_extra`: when the same name appears in both,
 * the curated value is the one that lands in the spawn args. This is
 * the behavior the wish prescribes (build the map with `_extra` first,
 * curated second) so curated overwrites.
 *
 * The helper is CJS so it can be required by tests that pre-date the
 * bun-only daemon path and by ES-module callers (postgres.js) via
 * Bun's CJS interop.
 */

'use strict';

const {
  GUC_NAME_REGEX,
  FORBIDDEN_VALUE_CHARS,
} = require('./settings-schema.cjs');

/**
 * Drop+warn check for a curated postgres leaf. Returns true when the
 * entry is safe to emit; false when it was dropped (logger.warn called).
 */
function validateLeafEntry(name, value, logger) {
  if (typeof name !== 'string' || !GUC_NAME_REGEX.test(name)) {
    logger?.warn?.(
      { guc: name, value },
      `dropping invalid postgres GUC name (must match ${GUC_NAME_REGEX})`,
    );
    return false;
  }
  return assertScalarSafe(name, value, logger);
}

/**
 * Drop+warn check for an entry under `postgres._extra`. Same shape as
 * validateLeafEntry but the message is scoped to `_extra` so operators
 * can locate the offending row.
 */
function validateExtraGuc(name, value, logger) {
  if (typeof name !== 'string' || !GUC_NAME_REGEX.test(name)) {
    logger?.warn?.(
      { guc: name, value, source: '_extra' },
      `dropping invalid postgres._extra GUC name (must match ${GUC_NAME_REGEX})`,
    );
    return false;
  }
  return assertScalarSafe(`_extra.${name}`, value, logger);
}

function assertScalarSafe(label, value, logger) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    logger?.warn?.(
      { guc: label, value },
      'dropping postgres GUC: value must be a scalar primitive (string|number|boolean)',
    );
    return false;
  }
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE_CHARS.test(value)) {
      logger?.warn?.(
        { guc: label, value },
        'dropping postgres GUC: value contains forbidden control character (\\n, \\r, or \\0)',
      );
      return false;
    }
    if (value.startsWith('-')) {
      logger?.warn?.(
        { guc: label, value },
        'dropping postgres GUC: value must not start with "-" (looks like a CLI flag)',
      );
      return false;
    }
  }
  return true;
}

/**
 * Stringify a GUC value for the `-c key=value` form.
 *
 * Booleans collapse to `on`/`off` (postgresql's canonical truth-y form)
 * so `autovacuum=true` lands as `autovacuum=on`. Numbers stringify as
 * decimal. Strings pass through unchanged (already validated).
 */
function formatGucValue(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * Build the ordered list of `-c key=value` pairs for the embedded
 * postgres process. Returns a flat array suitable for splicing into
 * the spawn argv (each pair is two consecutive entries: `-c`, `k=v`).
 *
 * Order:
 *   1. `_extra` first — populated, then overwritten by…
 *   2. Curated keys (`postgres.<key>`, excluding `_extra`).
 *
 * Drops invalid entries with logger.warn. Returns `{ args, applied }`
 * where `applied` is the final `{ key: stringValue }` map for tests
 * to inspect.
 */
function buildPostgresArgs(postgresSettings, { logger } = {}) {
  const merged = new Map();

  const extras = postgresSettings && postgresSettings._extra;
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
    for (const [k, v] of Object.entries(extras)) {
      if (validateExtraGuc(k, v, logger)) {
        merged.set(k, formatGucValue(v));
      }
    }
  }

  if (postgresSettings && typeof postgresSettings === 'object') {
    for (const [k, v] of Object.entries(postgresSettings)) {
      if (k === '_extra') continue;
      if (validateLeafEntry(k, v, logger)) {
        merged.set(k, formatGucValue(v));
      }
    }
  }

  const args = [];
  const applied = {};
  for (const [k, v] of merged) {
    args.push('-c', `${k}=${v}`);
    applied[k] = v;
  }
  return { args, applied };
}

module.exports = {
  buildPostgresArgs,
  validateLeafEntry,
  validateExtraGuc,
  formatGucValue,
};
