/**
 * Identifier validation tests
 *
 * Verifies that validateIdentifier rejects unsafe names before any SQL
 * is executed, closing the SQL injection vector in provision and enforcement.
 */

import { test, expect } from 'bun:test';
import { validateIdentifier } from '../../src/isolation/identifiers.js';

// ─── Valid identifiers ────────────────────────────────────────────────────────

test('identifiers - accepts simple lowercase name', () => {
  expect(() => validateIdentifier('myschema')).not.toThrow();
});

test('identifiers - accepts name with underscores', () => {
  expect(() => validateIdentifier('my_schema_name')).not.toThrow();
});

test('identifiers - accepts name starting with underscore', () => {
  expect(() => validateIdentifier('_private_schema')).not.toThrow();
});

test('identifiers - accepts name with uppercase letters', () => {
  expect(() => validateIdentifier('MySchema')).not.toThrow();
});

test('identifiers - accepts name with digits (not at start)', () => {
  expect(() => validateIdentifier('schema123')).not.toThrow();
});

// ─── Invalid identifiers ──────────────────────────────────────────────────────

test('identifiers - rejects name with a single quote', () => {
  expect(() => validateIdentifier("bad'name")).toThrow(/Invalid/);
});

test('identifiers - rejects name with double quote', () => {
  expect(() => validateIdentifier('bad"name')).toThrow(/Invalid/);
});

test('identifiers - rejects name with semicolon', () => {
  expect(() => validateIdentifier('bad;name')).toThrow(/Invalid/);
});

test('identifiers - rejects name with hyphen', () => {
  expect(() => validateIdentifier('bad-name')).toThrow(/Invalid/);
});

test('identifiers - rejects name starting with a digit', () => {
  expect(() => validateIdentifier('1badname')).toThrow(/Invalid/);
});

test('identifiers - rejects empty string', () => {
  expect(() => validateIdentifier('')).toThrow(/Invalid/);
});

test('identifiers - rejects name with space', () => {
  expect(() => validateIdentifier('bad name')).toThrow(/Invalid/);
});

test('identifiers - rejects SQL injection attempt', () => {
  expect(() => validateIdentifier("schema'; DROP TABLE users; --")).toThrow(/Invalid/);
});

test('identifiers - error message includes the label', () => {
  let caught;
  try {
    validateIdentifier("bad'name", 'schemaName');
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(caught.message).toContain('schemaName');
});
