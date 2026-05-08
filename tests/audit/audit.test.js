/**
 * Tests for src/audit/audit.js + scripts/audit-redaction-lint.js — Group 6.
 *
 * Three things under test:
 *
 *   1. `auditEmit()` writes a single JSON-Line record with schemaVersion: 1
 *      to a 0600 file under a 0700 directory.
 *   2. The redaction lint passes on the real `src/` tree (clean baseline).
 *   3. The redaction lint catches forbidden field names AND env-secret
 *      values AND postgres-URL-with-password values, with file:line errors.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import {
  auditEmit,
  configureAuditEmit,
  getAuditLogPath,
  AUDIT_OPS,
  AUDIT_SCHEMA_VERSION,
} from '../../src/audit/audit.js';
import { lintFile } from '../../scripts/audit-redaction-lint.js';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..');

let scratchDir;
let logFile;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-audit-test-'));
  logFile = path.join(scratchDir, 'logs', 'audit.log');
  configureAuditEmit({ logFile });
});

afterEach(() => {
  configureAuditEmit({});
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// --- src/audit/audit.js ---

test('auditEmit writes one JSON-line record per call with schemaVersion 1', () => {
  auditEmit({ op: AUDIT_OPS.CREATE_APP, app: 'omni', role: 'omni', actor: 'autopg_admin' });
  auditEmit({ op: AUDIT_OPS.REVOKE, app: 'omni', actor: 'autopg_admin' });

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  expect(lines.length).toBe(2);

  const r1 = JSON.parse(lines[0]);
  expect(r1.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
  expect(r1.schemaVersion).toBe(1);
  expect(r1.op).toBe('create-app');
  expect(r1.app).toBe('omni');
  expect(r1.role).toBe('omni');
  expect(r1.actor).toBe('autopg_admin');
  expect(typeof r1.ts).toBe('string');
  expect(new Date(r1.ts).toString()).not.toBe('Invalid Date');

  const r2 = JSON.parse(lines[1]);
  expect(r2.op).toBe('revoke');
});

test('audit log file is created with mode 0600 inside a 0700 dir', () => {
  auditEmit({ op: AUDIT_OPS.MANIFEST_VERIFY, app: 'omni', sigVerified: true, actor: 'cli' });

  const fileMode = fs.statSync(logFile).mode & 0o777;
  expect(fileMode).toBe(0o600);

  const dirMode = fs.statSync(path.dirname(logFile)).mode & 0o777;
  expect(dirMode).toBe(0o700);
});

test('auditEmit rejects unknown op with the allowed-list error', () => {
  expect(() =>
    auditEmit({ op: 'not-a-real-op', actor: 'cli' })
  ).toThrow(/unknown op "not-a-real-op"/);
});

test('auditEmit rejects non-object record', () => {
  expect(() => auditEmit(null)).toThrow(/record must be an object/);
});

test('auditEmit threads optional incidentId for bypass paths', () => {
  auditEmit({
    op: AUDIT_OPS.MANIFEST_VERIFY_BYPASS,
    app: 'omni',
    actor: 'cli',
    incidentId: 'INC-1234',
  });
  const rec = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
  expect(rec.incidentId).toBe('INC-1234');
  expect(rec.op).toBe('manifest-verify-bypass');
});

test('getAuditLogPath reflects the active configuration', () => {
  expect(getAuditLogPath()).toBe(logFile);
});

// --- scripts/audit-redaction-lint.js ---

test('redaction lint reports zero issues across the live src/ tree', () => {
  const child = spawnSync('bun', ['run', 'scripts/audit-redaction-lint.js'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(child.status).toBe(0);
  expect(child.stdout).toContain('0 issues');
});

test('redaction lint catches a forbidden "password" field name', () => {
  const fixture = path.join(scratchDir, 'bad-password.js');
  fs.writeFileSync(
    fixture,
    [
      "import { auditEmit } from '../../src/audit/audit.js';",
      "",
      "auditEmit({",
      "  op: 'create-app',",
      "  password: 'x',",
      "  actor: 'cli',",
      "});",
      "",
    ].join('\n')
  );

  const errors = lintFile(fixture);
  expect(errors.length).toBeGreaterThanOrEqual(1);
  const passwordErr = errors.find((e) => /forbidden secret pattern/i.test(e.message));
  expect(passwordErr).toBeDefined();
  expect(passwordErr.message).toMatch(/"password"/);
  // The auditEmit identifier is on line 3; the `password:` line is line 5.
  expect(passwordErr.line).toBe(5);
});

test('redaction lint catches secret/token/database_url field names', () => {
  for (const bad of ['secret', 'token', 'connection_string', 'database_url']) {
    const fixture = path.join(scratchDir, `bad-${bad}.js`);
    fs.writeFileSync(
      fixture,
      `auditEmit({ op: 'rotate', actor: 'cli', ${bad}: 'leak' });\n`
    );
    const errors = lintFile(fixture);
    const hit = errors.find((e) => e.message.includes(`"${bad}"`));
    expect(hit).toBeDefined();
  }
});

test('redaction lint catches process.env.*PASSWORD* values', () => {
  const fixture = path.join(scratchDir, 'bad-env.js');
  fs.writeFileSync(
    fixture,
    [
      "auditEmit({",
      "  op: 'rotate',",
      "  actor: 'cli',",
      "  hint: process.env.PG_PASSWORD,",
      "});",
      "",
    ].join('\n')
  );
  const errors = lintFile(fixture);
  expect(errors.find((e) => /sources from secret env var/.test(e.message))).toBeDefined();
});

test('redaction lint catches postgres URL with embedded password', () => {
  const fixture = path.join(scratchDir, 'bad-url.js');
  fs.writeFileSync(
    fixture,
    [
      "auditEmit({",
      "  op: 'create-app',",
      "  actor: 'cli',",
      "  conn: 'postgres://omni:hunter2@localhost/omni',",
      "});",
      "",
    ].join('\n')
  );
  const errors = lintFile(fixture);
  expect(errors.find((e) => /embedded password/.test(e.message))).toBeDefined();
});

test('redaction lint passes a clean auditEmit call with whitelisted fields', () => {
  const fixture = path.join(scratchDir, 'good.js');
  fs.writeFileSync(
    fixture,
    [
      "auditEmit({",
      "  op: 'create-app',",
      "  app: 'omni',",
      "  role: 'omni',",
      "  actor: 'autopg_admin',",
      "  manifestSha256: 'abc123',",
      "  sigVerified: true,",
      "});",
      "",
    ].join('\n')
  );
  expect(lintFile(fixture)).toEqual([]);
});

test('redaction lint ignores auditEmit-shaped substrings in comments and strings', () => {
  const fixture = path.join(scratchDir, 'comment-noise.js');
  fs.writeFileSync(
    fixture,
    [
      "// auditEmit({ password: 'x' }) — this is in a comment",
      "const note = \"auditEmit({ secret: 'y' })\";",
      "/* auditEmit({ token: 'z' }) */",
      "auditEmit({ op: 'create-app', actor: 'cli' });",
      "",
    ].join('\n')
  );
  expect(lintFile(fixture)).toEqual([]);
});
