/**
 * Managed superuser password resolution for the postmaster
 * (src/lib/postmaster-password.js).
 *
 * Locks the contract that fixed the omni k8s node-restart incident
 * (2026-07-03): PostgresManager always supported `options.password`
 * (initdb --pwfile + the TCP admin pool), but the postmaster entry never
 * wired it — so a supervisor-rotated superuser password crash-looped the
 * postmaster on every restart. The resolver reads the documented env
 * chain from settings-schema.cjs `server.pgPassword`.
 */

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  resolvePostmasterPassword,
  POSTMASTER_PASSWORD_ENV_VARS,
  DEFAULT_POSTMASTER_PASSWORD,
} from '../../src/lib/postmaster-password.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POSTGRES_SERVER = path.join(REPO_ROOT, 'bin', 'postgres-server.js');

describe('resolvePostmasterPassword', () => {
  test('defaults to the built-in password with an empty environment', () => {
    expect(resolvePostmasterPassword({})).toEqual({
      password: DEFAULT_POSTMASTER_PASSWORD,
      source: 'default',
    });
  });

  test('AUTOPG_PG_PASSWORD supplies the managed password', () => {
    expect(resolvePostmasterPassword({ AUTOPG_PG_PASSWORD: 's3cret' })).toEqual({
      password: 's3cret',
      source: 'AUTOPG_PG_PASSWORD',
    });
  });

  test('PGSERVE_PG_PASSWORD is honored as the legacy alias', () => {
    expect(resolvePostmasterPassword({ PGSERVE_PG_PASSWORD: 'legacy' })).toEqual({
      password: 'legacy',
      source: 'PGSERVE_PG_PASSWORD',
    });
  });

  test('AUTOPG_PG_PASSWORD wins over the legacy alias (schema env order)', () => {
    const env = { AUTOPG_PG_PASSWORD: 'new', PGSERVE_PG_PASSWORD: 'old' };
    expect(resolvePostmasterPassword(env).password).toBe('new');
  });

  test('empty-string env vars are treated as unset (cannot blank the pool password)', () => {
    const env = { AUTOPG_PG_PASSWORD: '', PGSERVE_PG_PASSWORD: '' };
    expect(resolvePostmasterPassword(env)).toEqual({
      password: DEFAULT_POSTMASTER_PASSWORD,
      source: 'default',
    });
  });

  test('env chain matches the settings-schema documented names', () => {
    expect(POSTMASTER_PASSWORD_ENV_VARS).toEqual(['AUTOPG_PG_PASSWORD', 'PGSERVE_PG_PASSWORD']);
  });
});

describe('postmaster --help documents the managed password env', () => {
  test('help text advertises AUTOPG_PG_PASSWORD and the legacy alias', () => {
    const result = spawnSync(process.execPath, [POSTGRES_SERVER, 'postmaster', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.stdout).toContain('AUTOPG_PG_PASSWORD');
    expect(result.stdout).toContain('PGSERVE_PG_PASSWORD');
  });
});
