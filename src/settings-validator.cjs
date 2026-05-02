/**
 * Settings validator — shared between CLI (`autopg config set …`) and the
 * UI helper (`PUT /api/settings`).
 *
 * Public surface:
 *   - validateSetting(key, value, { schema? }) — single-leaf check, throws
 *     ValidationError on failure.
 *   - validateAll(settings, { schema? }) — full-tree check; throws on first
 *     failure to keep error reporting deterministic for CLI (UI batches by
 *     calling per-field on form blur).
 *   - ValidationError — { code, field, message } shape, code is one of the
 *     7 stable codes.
 *   - ETAG_MISMATCH is exposed here so callers can `instanceof EtagMismatchError`
 *     uniformly; the writer is the only producer.
 *
 * 7 error codes:
 *   - INVALID_KEY       — key not in schema (and not under postgres._extra)
 *   - INVALID_GUC_NAME  — postgres._extra.<name> failed GUC_NAME_REGEX
 *   - INVALID_GUC_VALUE — postgres._extra.<name> value contains forbidden chars
 *   - INVALID_TYPE      — value type doesn't match schema (e.g. string for int)
 *   - OUT_OF_RANGE      — int/float value outside [min,max] or not in enum
 *   - READONLY          — attempted write to a readonly-marked field
 *   - ETAG_MISMATCH     — concurrent write detected (writer-side only)
 */

'use strict';

const {
  SCHEMA,
  GUC_NAME_REGEX,
  FORBIDDEN_VALUE_CHARS,
  flattenSchema,
} = require('./settings-schema.cjs');

const ERROR_CODES = Object.freeze({
  INVALID_KEY: 'INVALID_KEY',
  INVALID_GUC_NAME: 'INVALID_GUC_NAME',
  INVALID_GUC_VALUE: 'INVALID_GUC_VALUE',
  INVALID_TYPE: 'INVALID_TYPE',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  READONLY: 'READONLY',
  ETAG_MISMATCH: 'ETAG_MISMATCH',
});

class ValidationError extends Error {
  constructor(code, field, message) {
    super(`${field} — ${code}: ${message}`);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
    this.detail = message;
  }
}

class EtagMismatchError extends ValidationError {
  constructor(currentEtag, providedEtag) {
    super(
      ERROR_CODES.ETAG_MISMATCH,
      '_etag',
      `expected ${providedEtag ?? '(none)'} but file has ${currentEtag}`,
    );
    this.name = 'EtagMismatchError';
    this.currentEtag = currentEtag;
    this.providedEtag = providedEtag;
  }
}

/**
 * Coerce a value into the descriptor's type when the input is a string
 * (CLI argv path). `parse` is permissive; the caller should use the
 * coerced value when persisting so `set` round-trips through `get`.
 *
 * Returns the coerced value or throws ValidationError(INVALID_TYPE).
 */
function coerce(field, descriptor, value) {
  if (descriptor.type === 'guc_map') {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new ValidationError(
      ERROR_CODES.INVALID_TYPE,
      field,
      `expected object map, got ${describe(value)}`,
    );
  }
  if (descriptor.nullable && (value === null || value === '')) return value;

  switch (descriptor.type) {
    case 'int': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        return Number.parseInt(value, 10);
      }
      throw new ValidationError(
        ERROR_CODES.INVALID_TYPE,
        field,
        `expected integer, got ${describe(value)}`,
      );
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      throw new ValidationError(
        ERROR_CODES.INVALID_TYPE,
        field,
        `expected boolean, got ${describe(value)}`,
      );
    }
    case 'enum':
    case 'string': {
      if (typeof value === 'string') return value;
      // Permit numbers + booleans → string for ergonomics (e.g.
      // `config set ui.crt true`). The validator below enforces enum.
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      throw new ValidationError(
        ERROR_CODES.INVALID_TYPE,
        field,
        `expected string, got ${describe(value)}`,
      );
    }
    default:
      // Unknown type: pass through. Caller's validateLeaf will fail
      // with INVALID_KEY since this descriptor wouldn't be in the schema.
      return value;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate a single leaf against its schema descriptor (already coerced).
 * Throws ValidationError on failure; returns { ok: true, value } on success
 * (value is the (possibly normalized) value to persist).
 */
function validateLeaf(field, descriptor, value) {
  if (descriptor.readonly) {
    throw new ValidationError(
      ERROR_CODES.READONLY,
      field,
      'this field is read-only',
    );
  }
  if (descriptor.nullable && (value === null || value === '')) {
    return { ok: true, value };
  }

  switch (descriptor.type) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ValidationError(
          ERROR_CODES.INVALID_TYPE,
          field,
          `expected integer, got ${describe(value)}`,
        );
      }
      if (descriptor.range) {
        const [min, max] = descriptor.range;
        if (value < min || value > max) {
          throw new ValidationError(
            ERROR_CODES.OUT_OF_RANGE,
            field,
            `value ${value} outside [${min}, ${max}]`,
          );
        }
      }
      // GUCs (curated ints) also pass through the value-char check below
      // via toString during boot-time arg construction. Here we only check
      // shape.
      return { ok: true, value };
    }
    case 'bool': {
      if (typeof value !== 'boolean') {
        throw new ValidationError(
          ERROR_CODES.INVALID_TYPE,
          field,
          `expected boolean, got ${describe(value)}`,
        );
      }
      return { ok: true, value };
    }
    case 'enum': {
      if (typeof value !== 'string') {
        throw new ValidationError(
          ERROR_CODES.INVALID_TYPE,
          field,
          `expected string, got ${describe(value)}`,
        );
      }
      if (!descriptor.enum.includes(value)) {
        throw new ValidationError(
          ERROR_CODES.OUT_OF_RANGE,
          field,
          `must be one of [${descriptor.enum.join(', ')}], got "${value}"`,
        );
      }
      assertScalarSafe(field, value);
      return { ok: true, value };
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new ValidationError(
          ERROR_CODES.INVALID_TYPE,
          field,
          `expected string, got ${describe(value)}`,
        );
      }
      // GUC string values are tightened (no \n/\r/\0, no leading -).
      // Generic strings allow most characters but still ban nulls / newlines
      // because they break our log line parsing.
      assertScalarSafe(field, value, { strictGuc: !!descriptor.guc });
      return { ok: true, value };
    }
    case 'guc_map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError(
          ERROR_CODES.INVALID_TYPE,
          field,
          `expected object map, got ${describe(value)}`,
        );
      }
      // Validate every (key, value) inside the passthrough map.
      for (const [gucName, gucValue] of Object.entries(value)) {
        validateExtraEntry(`${field}.${gucName}`, gucName, gucValue);
      }
      return { ok: true, value };
    }
    default:
      throw new ValidationError(
        ERROR_CODES.INVALID_KEY,
        field,
        `unknown schema type "${descriptor.type}"`,
      );
  }
}

/**
 * Check a value for forbidden characters (\n / \r / \0) and, for GUC
 * values, also reject a leading `-` (would look like a CLI flag to
 * Bun.spawn array-form). Defense-in-depth alongside Bun.spawn's
 * shell-bypass.
 */
function assertScalarSafe(field, value, { strictGuc = false } = {}) {
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value !== 'string') {
    throw new ValidationError(
      ERROR_CODES.INVALID_GUC_VALUE,
      field,
      `expected scalar primitive, got ${describe(value)}`,
    );
  }
  if (FORBIDDEN_VALUE_CHARS.test(value)) {
    throw new ValidationError(
      ERROR_CODES.INVALID_GUC_VALUE,
      field,
      'value contains forbidden control character (\\n, \\r, or \\0)',
    );
  }
  if (strictGuc && value.startsWith('-')) {
    throw new ValidationError(
      ERROR_CODES.INVALID_GUC_VALUE,
      field,
      'value must not start with "-" (looks like a CLI flag)',
    );
  }
}

/**
 * Validate a single entry of `postgres._extra`. The key must match
 * GUC_NAME_REGEX; the value must be a scalar primitive and pass the
 * forbidden-char + leading-`-` checks.
 */
function validateExtraEntry(field, gucName, gucValue) {
  if (typeof gucName !== 'string' || !GUC_NAME_REGEX.test(gucName)) {
    throw new ValidationError(
      ERROR_CODES.INVALID_GUC_NAME,
      field,
      `must match ${GUC_NAME_REGEX} (lowercase ASCII, starts with letter)`,
    );
  }
  if (
    typeof gucValue !== 'string' &&
    typeof gucValue !== 'number' &&
    typeof gucValue !== 'boolean'
  ) {
    throw new ValidationError(
      ERROR_CODES.INVALID_GUC_VALUE,
      field,
      `expected scalar primitive, got ${describe(gucValue)}`,
    );
  }
  assertScalarSafe(field, gucValue, { strictGuc: true });
}

/**
 * Resolve a dotted key against the schema. Supports:
 *   - server.port             → schema leaf
 *   - postgres.shared_buffers → schema leaf
 *   - postgres._extra         → the guc_map leaf
 *   - postgres._extra.<name>  → dynamic entry under guc_map
 *
 * Returns { kind: 'leaf', descriptor } | { kind: 'extra-entry', gucName }
 * or throws INVALID_KEY.
 */
function resolveKey(key, schema = SCHEMA) {
  if (typeof key !== 'string' || !key.length) {
    throw new ValidationError(ERROR_CODES.INVALID_KEY, String(key), 'empty key');
  }
  const parts = key.split('.');
  if (parts.length === 2) {
    const [section, field] = parts;
    const descriptor = schema[section]?.[field];
    if (!descriptor) {
      throw new ValidationError(
        ERROR_CODES.INVALID_KEY,
        key,
        `not in schema (section="${section}", field="${field}")`,
      );
    }
    return { kind: 'leaf', descriptor };
  }
  if (parts.length === 3 && parts[0] === 'postgres' && parts[1] === '_extra') {
    return { kind: 'extra-entry', gucName: parts[2] };
  }
  throw new ValidationError(
    ERROR_CODES.INVALID_KEY,
    key,
    'unsupported key shape (only section.field or postgres._extra.<name>)',
  );
}

/**
 * Validate `value` against the descriptor for `key`. `value` may be a
 * string (from CLI argv); we coerce per descriptor.type before the
 * structural check.
 */
function validateSetting(key, value, { schema = SCHEMA } = {}) {
  const resolved = resolveKey(key, schema);
  if (resolved.kind === 'extra-entry') {
    validateExtraEntry(key, resolved.gucName, value);
    return { ok: true, value };
  }
  const coerced = coerce(key, resolved.descriptor, value);
  return validateLeaf(key, resolved.descriptor, coerced);
}

/**
 * Validate the entire settings tree. Throws on first failure for
 * deterministic CLI error reporting.
 */
function validateAll(settings, { schema = SCHEMA } = {}) {
  if (!settings || typeof settings !== 'object') {
    throw new ValidationError(ERROR_CODES.INVALID_TYPE, '_root', 'settings must be an object');
  }
  for (const [section, fields] of Object.entries(schema)) {
    const sectionValue = settings[section];
    if (sectionValue === undefined) continue; // missing section → fall back to defaults later
    if (!sectionValue || typeof sectionValue !== 'object') {
      throw new ValidationError(
        ERROR_CODES.INVALID_TYPE,
        section,
        `expected object, got ${describe(sectionValue)}`,
      );
    }
    for (const [field, descriptor] of Object.entries(fields)) {
      const dottedKey = `${section}.${field}`;
      if (!(field in sectionValue)) continue;
      validateLeaf(dottedKey, descriptor, sectionValue[field]);
    }
    // Reject unknown section keys to catch typos at write time.
    for (const field of Object.keys(sectionValue)) {
      if (!(field in fields)) {
        throw new ValidationError(
          ERROR_CODES.INVALID_KEY,
          `${section}.${field}`,
          `not in schema`,
        );
      }
    }
  }
  // Reject unknown top-level sections.
  for (const section of Object.keys(settings)) {
    // Allow internal metadata keys (start with `_`) so we can store
    // schema version markers without tripping the validator.
    if (section.startsWith('_')) continue;
    if (!(section in schema)) {
      throw new ValidationError(
        ERROR_CODES.INVALID_KEY,
        section,
        `not in schema`,
      );
    }
  }
  return { ok: true };
}

module.exports = {
  ERROR_CODES,
  ValidationError,
  EtagMismatchError,
  validateSetting,
  validateAll,
  resolveKey,
  // Test surface
  _internals: {
    coerce,
    validateLeaf,
    validateExtraEntry,
    assertScalarSafe,
    flattenSchema,
  },
};
