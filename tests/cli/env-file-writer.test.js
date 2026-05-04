/**
 * Tests for src/cli/env-file-writer.js — Group 5,
 * autopg-distribution-cutover wish.
 *
 * Acceptance criteria:
 *   - mode 0o600 on the resulting file
 *   - parent dir created with mode 0o700 when missing
 *   - atomic rename: no partial file is ever observable
 *   - rerun overwrites cleanly (no tmp leakage)
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeEnvFile,
  renderEnvFileBody,
  envFilePathFor,
} from '../../src/cli/env-file-writer.js';

let scratchDir;

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-env-writer-test-'));
});

afterEach(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('writeEnvFile', () => {
  test('creates parent dir mode 0o700 + writes file mode 0o600', () => {
    const target = path.join(scratchDir, 'nested', 'omni.env');
    writeEnvFile(target, 'DATABASE_URL=...\n');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(target)).mode & 0o700).toBe(0o700);
  });

  test('atomic: no .tmp file lingers after a successful write', () => {
    const target = path.join(scratchDir, 'omni.env');
    writeEnvFile(target, 'DATABASE_URL=foo\n');
    const lingering = fs.readdirSync(scratchDir).filter((f) => f.includes('omni.env.tmp'));
    expect(lingering.length).toBe(0);
  });

  test('overwrite: second call replaces the file content cleanly', () => {
    const target = path.join(scratchDir, 'omni.env');
    writeEnvFile(target, 'DATABASE_URL=v1\n');
    writeEnvFile(target, 'DATABASE_URL=v2\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('DATABASE_URL=v2\n');
  });

  test('preserves 0o600 even if the file pre-exists with broader perms', () => {
    const target = path.join(scratchDir, 'omni.env');
    fs.writeFileSync(target, 'DATABASE_URL=stale\n', { mode: 0o644 });
    writeEnvFile(target, 'DATABASE_URL=fresh\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe('renderEnvFileBody', () => {
  test('emits canonical DATABASE_URL=… line', () => {
    const body = renderEnvFileBody({ role: 'omni', password: 'pw', database: 'omni' });
    expect(body).toBe('DATABASE_URL=postgres://omni:pw@127.0.0.1:8432/omni\n');
  });

  test('URL-encodes password specials so reserved chars survive parsing', () => {
    const body = renderEnvFileBody({
      role: 'omni',
      password: 'p@ss/word with spaces',
      database: 'omni',
    });
    expect(body).toContain('p%40ss%2Fword%20with%20spaces');
  });

  test('honors host + port overrides', () => {
    const body = renderEnvFileBody({
      role: 'omni',
      password: 'pw',
      database: 'omni',
      host: '10.0.0.1',
      port: 5433,
    });
    expect(body).toContain('@10.0.0.1:5433/omni');
  });

  test('throws when required fields missing', () => {
    expect(() => renderEnvFileBody({ role: 'x', password: 'y' }))
      .toThrow(/role, password, and database/);
  });
});

describe('envFilePathFor', () => {
  test('joins configDir with <app>.env', () => {
    expect(envFilePathFor('omni', '/home/u/.autopg')).toBe('/home/u/.autopg/omni.env');
  });
});
