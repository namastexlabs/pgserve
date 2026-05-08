/**
 * Tests for `src/lib/admin-json.js` — supervisor record reader, atomic
 * merge-writer, and `assertSupervisor` helper.
 *
 * Cohort foundation for `pgserve-singleton-no-proxy` Group 1 +
 * `canonical-pgserve-pm2-supervision` Group 1.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ADMIN_FILE_MODE,
  ADMIN_FILE_NAME,
  SUPERVISOR_VALUES,
  assertSupervisor,
  getAdminFilePath,
  getDefaultConfigDir,
  readAdminJson,
  writeAdminJson,
} from '../../src/lib/admin-json.js';

let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-json-test-'));
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function makeRecord(overrides = {}) {
  return {
    supervisor: 'pm2',
    socketDir: '/run/user/1000/pgserve',
    port: 5432,
    installedAt: '2026-05-08T07:30:00.000Z',
    ...overrides,
  };
}

describe('SUPERVISOR_VALUES', () => {
  test('exposes the cohort-locked enum', () => {
    expect(SUPERVISOR_VALUES).toEqual(['pm2', 'systemd-user', 'launchd', 'external']);
  });
});

describe('getDefaultConfigDir', () => {
  test('honors AUTOPG_CONFIG_DIR over PGSERVE_CONFIG_DIR and HOME', () => {
    const original = {
      autopg: process.env.AUTOPG_CONFIG_DIR,
      pgserve: process.env.PGSERVE_CONFIG_DIR,
    };
    try {
      process.env.AUTOPG_CONFIG_DIR = '/tmp/autopg-x';
      process.env.PGSERVE_CONFIG_DIR = '/tmp/pgserve-x';
      expect(getDefaultConfigDir()).toBe('/tmp/autopg-x');
      delete process.env.AUTOPG_CONFIG_DIR;
      expect(getDefaultConfigDir()).toBe('/tmp/pgserve-x');
      delete process.env.PGSERVE_CONFIG_DIR;
      expect(getDefaultConfigDir()).toBe(path.join(os.homedir(), '.autopg'));
    } finally {
      if (original.autopg === undefined) delete process.env.AUTOPG_CONFIG_DIR;
      else process.env.AUTOPG_CONFIG_DIR = original.autopg;
      if (original.pgserve === undefined) delete process.env.PGSERVE_CONFIG_DIR;
      else process.env.PGSERVE_CONFIG_DIR = original.pgserve;
    }
  });
});

describe('readAdminJson', () => {
  test('returns null when the file is missing', () => {
    expect(readAdminJson({ configDir: tmpHome })).toBeNull();
  });

  test('returns null when the file is unreadable JSON', () => {
    fs.writeFileSync(path.join(tmpHome, ADMIN_FILE_NAME), 'not-json');
    expect(readAdminJson({ configDir: tmpHome })).toBeNull();
  });

  test('returns the parsed object when valid', () => {
    const file = path.join(tmpHome, ADMIN_FILE_NAME);
    fs.writeFileSync(file, JSON.stringify(makeRecord()));
    const got = readAdminJson({ configDir: tmpHome });
    expect(got).not.toBeNull();
    expect(got.supervisor).toBe('pm2');
    expect(got.port).toBe(5432);
  });
});

describe('writeAdminJson', () => {
  test('writes a fresh record with mode 0600', () => {
    const result = writeAdminJson(makeRecord(), { configDir: tmpHome });
    expect(result.supervisor).toBe('pm2');
    const file = getAdminFilePath(tmpHome);
    expect(fs.existsSync(file)).toBe(true);
    const stat = fs.statSync(file);
    // Mask off file-type bits; only the permission bits matter here.
    expect(stat.mode & 0o777).toBe(ADMIN_FILE_MODE);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.supervisor).toBe('pm2');
    expect(onDisk.socketDir).toBe('/run/user/1000/pgserve');
    expect(onDisk.port).toBe(5432);
    expect(onDisk.installedAt).toBe('2026-05-08T07:30:00.000Z');
  });

  test('atomic write does not leave the .tmp file around', () => {
    writeAdminJson(makeRecord(), { configDir: tmpHome });
    const leftovers = fs.readdirSync(tmpHome).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('merges with existing unrelated fields (scrypt Basic-Auth scheme survives)', () => {
    const file = getAdminFilePath(tmpHome);
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      scheme: 'scrypt',
      salt: 'abc',
      hash: 'def',
      createdAt: '2026-05-01T00:00:00.000Z',
    }));
    writeAdminJson(makeRecord(), { configDir: tmpHome });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.scheme).toBe('scrypt');
    expect(onDisk.salt).toBe('abc');
    expect(onDisk.hash).toBe('def');
    expect(onDisk.createdAt).toBe('2026-05-01T00:00:00.000Z');
    expect(onDisk.supervisor).toBe('pm2');
    expect(onDisk.port).toBe(5432);
  });

  test('overwrites supervisor fields on subsequent writes', () => {
    writeAdminJson(makeRecord(), { configDir: tmpHome });
    writeAdminJson(makeRecord({
      socketDir: '/tmp/pgserve',
      port: 5433,
      installedAt: '2026-05-09T00:00:00.000Z',
    }), { configDir: tmpHome });
    const got = readAdminJson({ configDir: tmpHome });
    expect(got.socketDir).toBe('/tmp/pgserve');
    expect(got.port).toBe(5433);
    expect(got.installedAt).toBe('2026-05-09T00:00:00.000Z');
  });

  test('refuses to downgrade Tier B → Tier A (pm2 over systemd-user)', () => {
    writeAdminJson(makeRecord({ supervisor: 'systemd-user' }), { configDir: tmpHome });
    expect(() => writeAdminJson(makeRecord({ supervisor: 'pm2' }), { configDir: tmpHome }))
      .toThrow(/Tier B/);
    try {
      writeAdminJson(makeRecord({ supervisor: 'pm2' }), { configDir: tmpHome });
    } catch (err) {
      expect(err.code).toBe('EADMINSUPERVISORLOCK');
      expect(err.existingSupervisor).toBe('systemd-user');
      expect(err.requestedSupervisor).toBe('pm2');
    }
  });

  test('refuses to downgrade launchd → external', () => {
    writeAdminJson(makeRecord({ supervisor: 'launchd' }), { configDir: tmpHome });
    expect(() => writeAdminJson(makeRecord({ supervisor: 'external' }), { configDir: tmpHome }))
      .toThrow(/Tier B|launchd/);
  });

  test('allows re-asserting the same Tier B supervisor', () => {
    writeAdminJson(makeRecord({ supervisor: 'systemd-user' }), { configDir: tmpHome });
    expect(() => writeAdminJson(makeRecord({
      supervisor: 'systemd-user',
      socketDir: '/run/user/1000/pgserve',
    }), { configDir: tmpHome })).not.toThrow();
  });

  test('rejects unknown supervisor enum values', () => {
    expect(() => writeAdminJson(makeRecord({ supervisor: 'docker' }), { configDir: tmpHome }))
      .toThrow(/invalid supervisor/);
  });

  test('rejects malformed records', () => {
    expect(() => writeAdminJson(makeRecord({ port: 0 }), { configDir: tmpHome })).toThrow(/port/);
    expect(() => writeAdminJson(makeRecord({ socketDir: '' }), { configDir: tmpHome }))
      .toThrow(/socketDir/);
    expect(() => writeAdminJson(makeRecord({ installedAt: '' }), { configDir: tmpHome }))
      .toThrow(/installedAt/);
  });
});

describe('assertSupervisor', () => {
  test('returns null when no admin.json exists (free host)', () => {
    expect(assertSupervisor('pm2', { configDir: tmpHome })).toBeNull();
  });

  test('returns the record when supervisor matches', () => {
    writeAdminJson(makeRecord(), { configDir: tmpHome });
    const got = assertSupervisor('pm2', { configDir: tmpHome });
    expect(got.supervisor).toBe('pm2');
  });

  test('throws structured error when supervisor differs', () => {
    writeAdminJson(makeRecord({ supervisor: 'systemd-user' }), { configDir: tmpHome });
    expect(() => assertSupervisor('pm2', { configDir: tmpHome })).toThrow(/supervisor mismatch/);
    try {
      assertSupervisor('pm2', { configDir: tmpHome });
    } catch (err) {
      expect(err.code).toBe('EADMINSUPERVISORMISMATCH');
      expect(err.expected).toBe('pm2');
      expect(err.actual).toBe('systemd-user');
    }
  });

  test('rejects unknown expected supervisor', () => {
    expect(() => assertSupervisor('docker', { configDir: tmpHome })).toThrow(/invalid expected/);
  });
});
