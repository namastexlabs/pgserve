/**
 * Tests for src/cli/autopg.js — revokeApp verb (Group 5,
 * autopg-distribution-cutover wish).
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { revokeApp, __test_internals as cli } from '../../src/cli/autopg.js';
import { configureAudit } from '../../src/audit.js';

let scratchDir;
let configDir;
let auditPath;

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

beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-revoke-test-'));
  configDir = path.join(scratchDir, '.autopg');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  auditPath = path.join(scratchDir, 'audit.log');
  configureAudit({ logFile: auditPath, target: 'file' });
});

afterEach(() => {
  cli.resetSqlExecutor();
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

function makeMockSql({ apps = [{ app: 'omni', role: 'omni', db: 'omni' }] } = {}) {
  const world = {
    apps: new Map(apps.map((a) => [a.app, { role: a.role, db: a.db, sha: 'abc', verified: true }])),
    databases: new Set(apps.map((a) => a.db)),
  };
  const calls = [];
  function exec({ sql, captureStdout }) {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    calls.push(trimmed);
    if (captureStdout) {
      if (/information_schema\.tables.*'autopg_apps'/.test(trimmed)) return 't';
      const m = trimmed.match(/WHERE app = '([^']+)'/);
      if (m && /SELECT app, role, db/.test(trimmed)) {
        const r = world.apps.get(m[1]);
        return r ? `${m[1]}|${r.role}|${r.db}|${r.sha}|t` : '';
      }
      const dbMatch = trimmed.match(/datname = '([^']+)'/);
      if (dbMatch) return world.databases.has(dbMatch[1]) ? 't' : 'f';
      throw new Error(`unexpected captureStdout SQL: ${trimmed}`);
    }
    if (/DROP DATABASE IF EXISTS (\w+)/.test(trimmed)) {
      const m = trimmed.match(/DROP DATABASE IF EXISTS (\w+)/);
      world.databases.delete(m[1]);
    }
    if (/DELETE FROM autopg_meta\.autopg_apps WHERE app = '([^']+)'/.test(trimmed)) {
      const m = trimmed.match(/WHERE app = '([^']+)'/);
      world.apps.delete(m[1]);
    }
    return undefined;
  }
  return { exec, world, calls };
}

describe('revokeApp', () => {
  test('removes meta row + drops role + reassigns owned objects (DB preserved by default)', async () => {
    const mock = makeMockSql();
    cli.setSqlExecutor(mock.exec);
    fs.writeFileSync(path.join(configDir, 'omni.env'), 'DATABASE_URL=...\n', { mode: 0o600 });

    const cap = captureStreams();
    const code = await revokeApp(['omni'], { ...cap, configDir });

    expect(code).toBe(0);
    expect(mock.world.apps.has('omni')).toBe(false);
    expect(mock.world.databases.has('omni')).toBe(true); // preserved
    expect(fs.existsSync(path.join(configDir, 'omni.env'))).toBe(false);
    expect(mock.calls.some((s) => /REASSIGN OWNED BY omni TO autopg_admin/.test(s))).toBe(true);
    expect(mock.calls.some((s) => /DROP ROLE IF EXISTS omni/.test(s))).toBe(true);
    expect(cap.out).toMatch(/preserved/);
  });

  test('--drop-db drops the database too', async () => {
    const mock = makeMockSql();
    cli.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await revokeApp(['omni', '--drop-db'], { ...cap, configDir });
    expect(code).toBe(0);
    expect(mock.world.databases.has('omni')).toBe(false);
    expect(cap.out).toMatch(/dropped/);
  });

  test('idempotent: re-running on already-revoked app returns 0 with helpful message', async () => {
    const mock = makeMockSql({ apps: [] });
    cli.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await revokeApp(['ghost'], { ...cap, configDir });
    expect(code).toBe(0);
    expect(cap.out).toMatch(/not found in autopg_meta\.autopg_apps/);
  });

  test('removes leftover env file even when meta row absent', async () => {
    const mock = makeMockSql({ apps: [] });
    cli.setSqlExecutor(mock.exec);
    fs.writeFileSync(path.join(configDir, 'orphan.env'), 'DATABASE_URL=...\n');
    const cap = captureStreams();
    const code = await revokeApp(['orphan'], { ...cap, configDir });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(configDir, 'orphan.env'))).toBe(false);
  });
});
