/**
 * Validator coverage: all 7 error codes, plus the success-path coercion
 * for CLI argv (string → typed) round-trips.
 */

import { test, expect, describe } from 'bun:test';

const {
  validateSetting,
  validateAll,
  ValidationError,
  ERROR_CODES,
} = require('../../src/settings-validator.cjs');

const { buildDefaults } = require('../../src/settings-schema.cjs');

describe('validateSetting — single leaf', () => {
  test('coerces stringified ints and round-trips the value', () => {
    const result = validateSetting('server.port', '9000');
    expect(result.ok).toBe(true);
    expect(result.value).toBe(9000);
  });

  test('coerces stringified booleans', () => {
    expect(validateSetting('runtime.autoProvision', 'true').value).toBe(true);
    expect(validateSetting('runtime.autoProvision', 'false').value).toBe(false);
  });

  test('passes valid enum value', () => {
    expect(validateSetting('runtime.logLevel', 'debug').ok).toBe(true);
  });

  test('INVALID_KEY: unknown section/field', () => {
    expect.assertions(3);
    try {
      validateSetting('serverz.port', 9000);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.INVALID_KEY);
      expect(err.field).toBe('serverz.port');
    }
  });

  test('INVALID_GUC_NAME: postgres._extra key with a space', () => {
    expect.assertions(3);
    try {
      validateSetting('postgres._extra.shared buffers', '128MB');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_NAME);
      expect(err.field).toBe('postgres._extra.shared buffers');
    }
  });

  test('INVALID_GUC_NAME: postgres._extra key with uppercase', () => {
    expect.assertions(2);
    try {
      validateSetting('postgres._extra.SharedBuffers', '128MB');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_NAME);
      expect(err.message).toContain('INVALID_GUC_NAME');
    }
  });

  test('INVALID_GUC_VALUE: forbidden newline in curated GUC value', () => {
    expect.assertions(2);
    try {
      validateSetting('postgres.shared_buffers', '128MB\n--malicious');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_VALUE);
      expect(err.field).toBe('postgres.shared_buffers');
    }
  });

  test('INVALID_GUC_VALUE: forbidden leading dash in GUC value', () => {
    expect.assertions(1);
    try {
      validateSetting('postgres.shared_buffers', '-128MB');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_VALUE);
    }
  });

  test('INVALID_GUC_VALUE: non-scalar in postgres._extra', () => {
    expect.assertions(1);
    try {
      validateSetting('postgres._extra.log_statement', { nested: 'no' });
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_VALUE);
    }
  });

  test('INVALID_TYPE: number expected, got non-numeric string', () => {
    expect.assertions(1);
    try {
      validateSetting('server.port', 'not-a-port');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_TYPE);
    }
  });

  test('OUT_OF_RANGE: int outside declared range', () => {
    expect.assertions(1);
    try {
      validateSetting('server.port', 70000);
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.OUT_OF_RANGE);
    }
  });

  test('OUT_OF_RANGE: enum value not in allowed list', () => {
    expect.assertions(1);
    try {
      validateSetting('runtime.logLevel', 'fatal');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.OUT_OF_RANGE);
    }
  });

  test('READONLY: synthesized via a marked descriptor', () => {
    // The schema doesn't yet mark anything readonly — drive the path
    // by injecting a custom descriptor through validateLeaf directly.
    const { _internals } = require('../../src/settings-validator.cjs');
    expect.assertions(1);
    try {
      _internals.validateLeaf('fake.field', { type: 'string', readonly: true }, 'x');
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.READONLY);
    }
  });

  test('ETAG_MISMATCH error code is exported', () => {
    // The code is exposed via ERROR_CODES and EtagMismatchError; the
    // writer test exercises the throwing path. Here we just lock the
    // surface so a refactor can't quietly drop it.
    expect(ERROR_CODES.ETAG_MISMATCH).toBe('ETAG_MISMATCH');
  });
});

describe('validateAll — full tree', () => {
  test('accepts the schema defaults', () => {
    expect(validateAll(buildDefaults()).ok).toBe(true);
  });

  test('rejects an unknown top-level section', () => {
    const tree = { ...buildDefaults(), bogus: { x: 1 } };
    expect.assertions(1);
    try {
      validateAll(tree);
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_KEY);
    }
  });

  test('rejects an unknown field inside a known section', () => {
    const tree = buildDefaults();
    tree.server.bogus = 'nope';
    expect.assertions(1);
    try {
      validateAll(tree);
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_KEY);
    }
  });

  test('drills into postgres._extra and surfaces the offending entry', () => {
    const tree = buildDefaults();
    tree.postgres._extra = { 'BAD KEY': 'whatever' };
    expect.assertions(1);
    try {
      validateAll(tree);
    } catch (err) {
      expect(err.code).toBe(ERROR_CODES.INVALID_GUC_NAME);
    }
  });

  test('allows _-prefixed top-level metadata (e.g. _schemaVersion)', () => {
    const tree = { ...buildDefaults(), _schemaVersion: 1, _migratedFrom: 'foo' };
    expect(validateAll(tree).ok).toBe(true);
  });
});
