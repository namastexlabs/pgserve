/**
 * Tests for src/cli-config.cjs (the `autopg config` sub-router).
 *
 * Strategy:
 *   - Spawn the wrapper with AUTOPG_CONFIG_DIR pointing at a tempdir so each
 *     test owns its own settings file.
 *   - Drive every subcommand (list / get / set / path / init) and assert
 *     stdout, stderr, exit codes, and the on-disk file shape.
 *
 * The wrapper's bun-probe is bypassed because `config` is in the
 * __installSubcommands set — see bin/pgserve-wrapper.cjs.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'pgserve-wrapper.cjs');

let tmpHome;

function runCli(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTOPG_CONFIG_DIR: tmpHome,
      // Strip any inherited AUTOPG_*/PGSERVE_* that would shift sources
      // away from `default`/`file` and break the source-column assertions.
      AUTOPG_PORT: '',
      AUTOPG_LOG_LEVEL: '',
      PGSERVE_PORT: '',
      PGSERVE_LOG_LEVEL: '',
      LOG_LEVEL: '',
      ...env,
    },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-config-cli-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('autopg config path', () => {
  test('prints the absolute settings.json path under AUTOPG_CONFIG_DIR', () => {
    const result = runCli(['config', 'path']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(tmpHome, 'settings.json'));
  });
});

describe('autopg config init', () => {
  test('writes defaults on a fresh path', () => {
    const result = runCli(['config', 'init']);
    expect(result.status).toBe(0);
    const settingsPath = path.join(tmpHome, 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const tree = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(tree.server.port).toBe(8432);
    expect(tree.postgres.shared_buffers).toBe('128MB');
  });

  test('refuses to clobber without --force', () => {
    runCli(['config', 'init']);
    const result = runCli(['config', 'init']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('EEXIST');
    expect(result.stderr).toContain('already exists');
  });

  test('--force overwrites an existing file', () => {
    runCli(['config', 'init']);
    runCli(['config', 'set', 'server.port', '9000']);
    const result = runCli(['config', 'init', '--force']);
    expect(result.status).toBe(0);
    const tree = JSON.parse(fs.readFileSync(path.join(tmpHome, 'settings.json'), 'utf8'));
    expect(tree.server.port).toBe(8432);
  });

  test('writes settings.json at mode 0600 (POSIX)', () => {
    if (process.platform === 'win32') return;
    runCli(['config', 'init']);
    const mode = fs.statSync(path.join(tmpHome, 'settings.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('autopg config list', () => {
  test('prints a header and one row per leaf with KEY|VALUE|SOURCE', () => {
    const result = runCli(['config', 'list']);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    // Header + at least 20 leaves across 6 sections + _extra placeholder.
    expect(lines.length).toBeGreaterThan(20);
    expect(lines[0]).toMatch(/KEY/);
    expect(lines[0]).toMatch(/VALUE/);
    expect(lines[0]).toMatch(/SOURCE/);
    // Every body row has the three columns separated by whitespace.
    const portRow = lines.find((l) => l.startsWith('server.port'));
    expect(portRow).toBeDefined();
    expect(portRow).toContain('8432');
    expect(portRow).toContain('default');
  });

  test('marks env-overridden rows with env:<NAME>', () => {
    const result = runCli(['config', 'list'], { AUTOPG_PORT: '9100' });
    expect(result.status).toBe(0);
    const portRow = result.stdout.split('\n').find((l) => l.startsWith('server.port'));
    expect(portRow).toContain('9100');
    expect(portRow).toContain('env:AUTOPG_PORT');
  });

  test('marks file-overridden rows with file', () => {
    runCli(['config', 'set', 'postgres.shared_buffers', '256MB']);
    const result = runCli(['config', 'list']);
    const row = result.stdout.split('\n').find((l) => l.startsWith('postgres.shared_buffers'));
    expect(row).toContain('256MB');
    expect(row).toContain('file');
  });
});

describe('autopg config get', () => {
  test('prints just the value for a curated leaf', () => {
    const result = runCli(['config', 'get', 'postgres.shared_buffers']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('128MB');
  });

  test('prints a number for int leaves', () => {
    const result = runCli(['config', 'get', 'server.port']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('8432');
  });

  test('round-trips through set', () => {
    runCli(['config', 'set', 'postgres.shared_buffers', '192MB']);
    const result = runCli(['config', 'get', 'postgres.shared_buffers']);
    expect(result.stdout.trim()).toBe('192MB');
  });

  test('rejects unknown keys with INVALID_KEY (exit 2)', () => {
    const result = runCli(['config', 'get', 'foo.bar']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_KEY');
  });
});

describe('autopg config set', () => {
  test('persists curated leaf and round-trips', () => {
    const set = runCli(['config', 'set', 'postgres.shared_buffers', '256MB']);
    expect(set.status).toBe(0);
    const get = runCli(['config', 'get', 'postgres.shared_buffers']);
    expect(get.stdout.trim()).toBe('256MB');
  });

  test('coerces numeric strings to int for int leaves', () => {
    runCli(['config', 'set', 'server.port', '9001']);
    const get = runCli(['config', 'get', 'server.port']);
    expect(get.stdout.trim()).toBe('9001');
  });

  test('writes _extra entry for postgres._extra.<gucName>', () => {
    runCli(['config', 'set', 'postgres._extra.log_statement', 'all']);
    const tree = JSON.parse(fs.readFileSync(path.join(tmpHome, 'settings.json'), 'utf8'));
    expect(tree.postgres._extra).toEqual({ log_statement: 'all' });
  });

  test('rejects INVALID_KEY with exit 2 + stable stderr shape', () => {
    const result = runCli(['config', 'set', 'foo', 'bar']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^error: foo — INVALID_KEY:/);
  });

  test('rejects INVALID_GUC_NAME for malformed _extra key (exit 2)', () => {
    const result = runCli(['config', 'set', 'postgres._extra.shared buffers', '128MB']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_GUC_NAME');
    // Ensure the file wasn't written on the validation failure.
    expect(fs.existsSync(path.join(tmpHome, 'settings.json'))).toBe(false);
  });

  test('rejects OUT_OF_RANGE for an int outside the schema range', () => {
    const result = runCli(['config', 'set', 'server.port', '99999']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OUT_OF_RANGE');
  });

  test('rejects INVALID_TYPE when an int leaf gets a non-numeric value', () => {
    const result = runCli(['config', 'set', 'server.port', 'not-a-port']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('INVALID_TYPE');
  });
});

describe('alias parity', () => {
  test('pgserve config list and autopg config list produce identical stdout', () => {
    runCli(['config', 'init']);

    const viaPgserve = spawnSync(
      'node',
      [path.join(REPO_ROOT, 'bin', 'pgserve-wrapper.cjs'), 'config', 'list'],
      {
        encoding: 'utf8',
        env: { ...process.env, AUTOPG_CONFIG_DIR: tmpHome, AUTOPG_PORT: '', PGSERVE_PORT: '' },
      },
    );
    const viaAutopg = spawnSync(
      'node',
      [path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'), 'config', 'list'],
      {
        encoding: 'utf8',
        env: { ...process.env, AUTOPG_CONFIG_DIR: tmpHome, AUTOPG_PORT: '', PGSERVE_PORT: '' },
      },
    );
    expect(viaAutopg.status).toBe(0);
    expect(viaPgserve.status).toBe(0);
    expect(viaAutopg.stdout).toBe(viaPgserve.stdout);
  });
});

describe('unknown subcommand', () => {
  test('exits 1 with usage line on bare `autopg config bogus`', () => {
    const result = runCli(['config', 'bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown config subcommand');
    expect(result.stderr).toContain('usage:');
  });
});
