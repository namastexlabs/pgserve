/**
 * Tests for src/cli/autopg.js — createApp verb (Group 5,
 * autopg-distribution-cutover wish).
 *
 * Acceptance criteria covered:
 *   - Idempotent re-create with same manifest → no error, no rotation.
 *   - Unsigned manifest rejected with the locked S9 error text.
 *   - --unsafe-unverified <INCIDENT_ID> bypass writes audit row.
 *   - --adopt-existing-db skips CREATE DATABASE, GRANTs to existing DB.
 *   - Env file written with mode 0600 carrying DATABASE_URL.
 *   - Manifest with mismatched name vs flag is rejected.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createApp,
  __test_internals as cliInternals,
} from '../../src/cli/autopg.js';
import {
  __test_internals as verifyInternals,
} from '../../src/auth/manifest-verify.js';
import { configureAudit } from '../../src/audit.js';

let scratchDir;
let configDir;
let auditPath;

function makeMockSql() {
  const world = {
    metaTable: true,
    apps: new Map(),         // app → {role, db, sha, verified}
    roles: new Set(),
    databases: new Set(),
    extensions: new Map(),   // db → Set(name)
  };
  const calls = [];
  function exec({ db, sql, captureStdout }) {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    calls.push({ db: db || 'postgres', sql: trimmed });

    if (captureStdout) {
      if (/information_schema\.tables.*'autopg_meta'.*'autopg_apps'/.test(trimmed)) {
        return world.metaTable ? 't' : 'f';
      }
      if (/FROM autopg_meta\.autopg_apps WHERE app = '([^']+)'/.test(trimmed)) {
        const m = trimmed.match(/WHERE app = '([^']+)'/);
        const r = world.apps.get(m[1]);
        return r ? `${m[1]}|${r.role}|${r.db}|${r.sha}|${r.verified ? 't' : 'f'}` : '';
      }
      if (/FROM pg_roles WHERE rolname = '([^']+)'/.test(trimmed)) {
        const m = trimmed.match(/rolname = '([^']+)'/);
        return world.roles.has(m[1]) ? 't' : 'f';
      }
      if (/FROM pg_database WHERE datname = '([^']+)'/.test(trimmed)) {
        const m = trimmed.match(/datname = '([^']+)'/);
        return world.databases.has(m[1]) ? 't' : 'f';
      }
      if (/SELECT app, role, db, manifest_sig_verified FROM autopg_meta\.autopg_apps/.test(trimmed)) {
        return [...world.apps.entries()]
          .map(([a, r]) => `${a}|${r.role}|${r.db}|${r.verified ? 't' : 'f'}`)
          .join('\n');
      }
      throw new Error(`unexpected captureStdout SQL: ${trimmed}`);
    }

    if (/CREATE ROLE (\w+) /.test(trimmed)) {
      const m = trimmed.match(/CREATE ROLE (\w+) /);
      world.roles.add(m[1]);
      return undefined;
    }
    if (/ALTER ROLE \w+ WITH LOGIN PASSWORD/.test(trimmed)) return undefined;
    if (/ALTER ROLE \w+ CONNECTION LIMIT/.test(trimmed)) return undefined;
    if (/CREATE DATABASE (\w+) OWNER /.test(trimmed)) {
      const m = trimmed.match(/CREATE DATABASE (\w+) OWNER /);
      world.databases.add(m[1]);
      return undefined;
    }
    if (/GRANT |REVOKE |ALTER DEFAULT PRIVILEGES/.test(trimmed)) return undefined;
    if (/CREATE EXTENSION IF NOT EXISTS "([^"]+)"/.test(trimmed)) {
      const m = trimmed.match(/CREATE EXTENSION IF NOT EXISTS "([^"]+)"/);
      const set = world.extensions.get(db) || new Set();
      set.add(m[1]);
      world.extensions.set(db, set);
      return undefined;
    }
    if (/INSERT INTO autopg_meta\.autopg_apps/.test(trimmed)) {
      const values = trimmed.match(/VALUES \('([^']+)', '([^']+)', '([^']+)', '([^']+)', (TRUE|FALSE)\)/);
      if (values) {
        world.apps.set(values[1], {
          role: values[2],
          db: values[3],
          sha: values[4],
          verified: values[5] === 'TRUE',
        });
      }
      return undefined;
    }
    if (/REASSIGN OWNED BY |DROP OWNED BY |DROP ROLE IF EXISTS|DROP DATABASE IF EXISTS|DELETE FROM/.test(trimmed)) {
      return undefined;
    }
    return undefined;
  }
  return { exec, world, calls };
}

function writeManifest(p, body) {
  fs.writeFileSync(p, JSON.stringify(body, null, 2));
}

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
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-create-app-test-'));
  configDir = path.join(scratchDir, '.autopg');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  auditPath = path.join(scratchDir, 'audit.log');
  configureAudit({ logFile: auditPath, target: 'file' });
  // Default verifier: succeeds (signed manifest happy-path)
  verifyInternals.setVerifier(() => ({ ok: true, output: 'Verified OK' }));
});

afterEach(() => {
  cliInternals.resetSqlExecutor();
  verifyInternals.resetVerifier();
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe('createApp — happy path with signed manifest', () => {
  test('provisions role + DB + meta row + env file, exit 0', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'omni', needs: { database: 'omni' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake-sig-bytes');
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(['omni', '--manifest', manifestPath], {
      ...cap,
      configDir,
      port: 8432,
    });

    expect(code).toBe(0);
    expect(mock.world.roles.has('omni')).toBe(true);
    expect(mock.world.databases.has('omni')).toBe(true);
    expect(mock.world.apps.get('omni').verified).toBe(true);

    const envFile = path.join(configDir, 'omni.env');
    expect(fs.existsSync(envFile)).toBe(true);
    const stat = fs.statSync(envFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(envFile, 'utf8');
    expect(body).toMatch(/^DATABASE_URL=postgres:\/\/omni:[^@]+@127\.0\.0\.1:8432\/omni\n$/);

    delete process.env.AUTOPG_COSIGN_PUB;
  });
});

describe('createApp — idempotent re-run', () => {
  test('same manifest twice → idempotent-skip, no error', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'omni', needs: { database: 'omni' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake');
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);

    const cap1 = captureStreams();
    const r1 = await createApp(['omni', '--manifest', manifestPath], { ...cap1, configDir });
    expect(r1).toBe(0);

    const cap2 = captureStreams();
    const r2 = await createApp(['omni', '--manifest', manifestPath], { ...cap2, configDir });
    expect(r2).toBe(0);
    expect(cap2.out).toMatch(/already provisioned \(idempotent-skip\)/);

    delete process.env.AUTOPG_COSIGN_PUB;
  });
});

describe('createApp — unsigned manifest rejected', () => {
  test('S9 error text returned, exit 1, no provisioning', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'omni', needs: { database: 'omni' } });
    // No .sig file
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(['omni', '--manifest', manifestPath], { ...cap, configDir });

    expect(code).toBe(1);
    expect(cap.err).toContain('manifest unsigned. add publisher sig or pass `--unsafe-unverified <INCIDENT_ID>`');
    expect(mock.world.roles.has('omni')).toBe(false);

    delete process.env.AUTOPG_COSIGN_PUB;
  });
});

describe('createApp — --unsafe-unverified bypass', () => {
  test('bypasses verification, writes audit row tagged with incident id', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'omni', needs: { database: 'omni' } });
    // No .sig file
    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(
      ['omni', '--manifest', manifestPath, '--unsafe-unverified', 'TICKET-123'],
      { ...cap, configDir },
    );

    expect(code).toBe(0);
    expect(cap.err).toMatch(/--unsafe-unverified TICKET-123/);
    expect(mock.world.apps.get('omni').verified).toBe(false);

    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    const bypass = auditLines.find((e) => e.event === 'autopg_manifest_unsafe_bypass');
    expect(bypass).toBeTruthy();
    expect(bypass.incident_id).toBe('TICKET-123');
  });
});

describe('createApp — --adopt-existing-db', () => {
  test('skips CREATE DATABASE, only GRANTs on existing DB', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'genie', needs: { database: 'genie' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake');
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    mock.world.databases.add('genie'); // pre-existing
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(
      ['genie', '--manifest', manifestPath, '--adopt-existing-db', 'genie'],
      { ...cap, configDir },
    );

    expect(code).toBe(0);
    const createDbCalls = mock.calls.filter((c) => /CREATE DATABASE/.test(c.sql));
    expect(createDbCalls.length).toBe(0);
    const grantCalls = mock.calls.filter((c) => /GRANT/.test(c.sql));
    expect(grantCalls.length).toBeGreaterThan(0);

    delete process.env.AUTOPG_COSIGN_PUB;
  });

  test('rejects --adopt-existing-db when DB does not exist', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'genie', needs: { database: 'genie' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake');
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(
      ['genie', '--manifest', manifestPath, '--adopt-existing-db', 'genie'],
      { ...cap, configDir },
    );

    expect(code).toBe(1);
    expect(cap.err).toMatch(/cannot adopt a missing database/);

    delete process.env.AUTOPG_COSIGN_PUB;
  });
});

describe('createApp — name vs manifest mismatch', () => {
  test('rejects when positional name does not match manifest.app', async () => {
    const manifestPath = path.join(scratchDir, 'autopg.json');
    writeManifest(manifestPath, { app: 'omni', needs: { database: 'omni' } });
    fs.writeFileSync(`${manifestPath}.sig`, 'fake');
    const pubKeyPath = path.join(scratchDir, 'cosign.pub');
    fs.writeFileSync(pubKeyPath, 'FAKE');
    process.env.AUTOPG_COSIGN_PUB = pubKeyPath;

    const mock = makeMockSql();
    cliInternals.setSqlExecutor(mock.exec);
    const cap = captureStreams();
    const code = await createApp(['genie', '--manifest', manifestPath], { ...cap, configDir });

    expect(code).toBe(1);
    expect(cap.err).toMatch(/does not match manifest\.app/);

    delete process.env.AUTOPG_COSIGN_PUB;
  });
});
