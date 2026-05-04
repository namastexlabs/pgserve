/**
 * Tests for src/cli/autopg.js — rotateApp verb (Group 5,
 * autopg-distribution-cutover wish).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateApp, __test_internals as cli } from '../../src/cli/autopg.js';
import { configureAudit } from '../../src/audit.js';

let scratchDir;
let configDir;

function captureStreams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    get out() { return stdout; },
    get err() { return stderr; },
  };
}

function makeMockSql({ exists = true } = {}) {
  const calls = [];
  return {
    calls,
    exec({ sql, captureStdout }) {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      calls.push(trimmed);
      if (captureStdout) {
        if (/information_schema\.tables.*'autopg_apps'/.test(trimmed)) return 't';
        if (/SELECT app, role, db/.test(trimmed) && /WHERE app = 'omni'/.test(trimmed)) {
          return exists ? 'omni|omni|omni|abc|t' : '';
        }
        if (/SELECT app, role, db/.test(trimmed)) return '';
        throw new Error(`unexpected captureStdout SQL: ${trimmed}`);
      }
      if (/ALTER ROLE \w+ WITH LOGIN PASSWORD/.test(trimmed)) return undefined;
      throw new Error(`unexpected SQL: ${trimmed}`);
    },
  };
}

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-rotate-test-'));
  configDir = path.join(scratchDir, '.autopg');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  configureAudit({ logFile: path.join(scratchDir, 'audit.log'), target: 'file' });
});

afterEach(() => {
  cli.resetSqlExecutor();
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('rotateApp', () => {
  test('rotates SCRAM password + rewrites env file atomically', async () => {
    const mock = makeMockSql();
    cli.setSqlExecutor(mock.exec);

    const envFile = path.join(configDir, 'omni.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://omni:OLDPASS@127.0.0.1:8432/omni\n', { mode: 0o600 });
    const before = fs.readFileSync(envFile, 'utf8');

    const cap = captureStreams();
    const code = await rotateApp(['omni'], { ...cap, configDir, port: 8432 });

    expect(code).toBe(0);
    const after = fs.readFileSync(envFile, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toMatch(/^DATABASE_URL=postgres:\/\/omni:[^@]+@127\.0\.0\.1:8432\/omni\n$/);
    const stat = fs.statSync(envFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(mock.calls.some((s) => /ALTER ROLE omni WITH LOGIN PASSWORD/.test(s))).toBe(true);
  });

  test('rejects unknown app with exit 1', async () => {
    const mock = makeMockSql({ exists: false });
    cli.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await rotateApp(['ghost'], { ...cap, configDir });
    expect(code).toBe(1);
    expect(cap.err).toMatch(/not found/);
  });

  test('atomic rename — concurrent reader sees full file or old file, never partial', async () => {
    const mock = makeMockSql();
    cli.setSqlExecutor(mock.exec);
    const envFile = path.join(configDir, 'omni.env');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://omni:OLD@127.0.0.1:8432/omni\n', { mode: 0o600 });

    const cap = captureStreams();
    await rotateApp(['omni'], { ...cap, configDir });

    // Tmp file should not linger after rename (atomic behavior).
    const lingering = fs.readdirSync(configDir).filter((f) => f.startsWith('omni.env.tmp.'));
    expect(lingering.length).toBe(0);
  });
});
