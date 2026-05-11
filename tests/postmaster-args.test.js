/**
 * Group 2 of `pgserve-singleton-no-proxy` — locks the data-plane contract
 * after the bun proxy was removed:
 *
 *   - bin/postgres-server.js exposes ONLY the `postmaster` (and `serve`
 *     alias) entry point. There is no daemon mode, no foreground router,
 *     no libpq protocol rewriting layer, no SO_PEERCRED handshake.
 *   - `--help` is the catch-all for unknown / missing subcommands.
 *   - The wrapper aliases `serve` to `postmaster`, not to `daemon`.
 *   - Audit moves to postgres-native logging (pgaudit when the .so is
 *     bundled, `log_statement=all` fallback otherwise) — the application-
 *     level audit-log writer (src/audit.js) is gone.
 *   - `config/logrotate.d/pgserve` ships in the package files list.
 */

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const POSTGRES_SERVER = path.join(REPO_ROOT, 'bin', 'postgres-server.js');
const WRAPPER = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

function runScript(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('postgres-server.js — postmaster-only entry surface', () => {
  test('--help prints the trimmed v2.4 surface (postmaster + serve, no daemon, no foreground)', () => {
    const result = runScript(POSTGRES_SERVER, ['--help']);
    expect(result.stdout).toContain('postmaster');
    expect(result.stdout).toContain('serve');
    expect(result.stdout).not.toContain('--listen');
    // Daemon control socket and foreground router are gone — the help
    // text must not advertise them or operators will chase deleted code
    // paths from muscle memory.
    expect(result.stdout).not.toMatch(/pgserve daemon\b/);
    expect(result.stdout).not.toMatch(/issue-token/);
    expect(result.stdout).not.toMatch(/router/i);
  });

  test('`pgserve postmaster --help` documents the direct-supervision contract', () => {
    const result = runScript(POSTGRES_SERVER, ['postmaster', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--port');
    expect(result.stdout).toContain('--socket-dir');
    expect(result.stdout).toContain('--data');
    expect(result.stdout).toContain('no router, no bun proxy');
  });

  test('unknown top-level subcommand prints help and exits non-zero', () => {
    const result = runScript(POSTGRES_SERVER, ['daemon']);
    expect(result.status).not.toBe(0);
    // Help should still surface — a non-zero exit + help is the standard
    // CLI shape for "unknown command".
    expect(result.stdout).toContain('postmaster');
  });

  test('postmaster --port rejects malformed values', () => {
    const result = runScript(POSTGRES_SERVER, ['postmaster', '--port', 'not-a-number']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid --port');
  });
});

describe('wrapper — serve alias points at postmaster, not daemon', () => {
  test('the wrapper rewrites `serve` to `postmaster` in argv', () => {
    // Read the wrapper source — the rewrite is done in pure JS before
    // bun is even spawned, so we can inspect the literal mapping rather
    // than starting a real postmaster.
    const src = fs.readFileSync(WRAPPER, 'utf8');
    expect(src).toMatch(/__subcommand === 'serve'[\s\S]*process\.argv\[2\] = 'postmaster'/);
    // The legacy `daemon` rewrite is gone.
    expect(src).not.toMatch(/process\.argv\[2\]\s*=\s*'daemon'/);
  });
});

describe('proxy data plane — sources removed', () => {
  test.each([
    'src/router.js',
    'src/pg-wire.js',
    'src/protocol.js',
    'src/cluster.js',
    'src/sync.js',
    'src/sdk.js',
    'src/tenancy.js',
    'src/restore.js',
    'src/admin-client.js',
    'src/control-db.js',
    'src/audit.js',
    'src/daemon.js',
    'src/daemon-tcp.js',
    'src/daemon-control.js',
    'src/daemon-shared.js',
    'src/gc.js',
    'src/tokens.js',
    'src/fingerprint.js',
    'src/dashboard.js',
    'src/stats-collector.js',
    'src/stats-dashboard.js',
  ])('%s is gone', (relPath) => {
    expect(fs.existsSync(path.join(REPO_ROOT, relPath))).toBe(false);
  });

  test('src/index.js exports only PostgresManager', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.js'), 'utf8');
    expect(src).toMatch(/export \{ PostgresManager \} from '\.\/postgres\.js'/);
    expect(src).not.toMatch(/MultiTenantRouter|startMultiTenantServer|PgserveDaemon|SyncManager|RestoreManager|StatsCollector|StatsDashboard|Dashboard/);
  });
});

describe('audit — pgaudit / log_statement fallback', () => {
  test('PostgresManager._startPostgres emits pgaudit GUCs when pgaudit.so is present, log_statement=all otherwise', () => {
    // Pure source-level lock: the spawn args must reference both pgaudit
    // and the fallback. The runtime decision (which one fires) depends
    // on whether the embedded postgres bundle ships pgaudit.so — that's
    // a separate cohort task and can't be asserted from here.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'postgres.js'), 'utf8');
    expect(src).toContain('shared_preload_libraries=pgaudit');
    expect(src).toContain('pgaudit.log=all');
    expect(src).toContain('log_statement=all');
    expect(src).toContain('pgaudit.so');
  });
});

describe('logrotate config ships in the package', () => {
  test('config/logrotate.d/pgserve exists with the expected directives', () => {
    const file = path.join(REPO_ROOT, 'config', 'logrotate.d', 'pgserve');
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    // copytruncate is critical so pm2 / systemd-user / launchd file
    // handles keep writing post-rotate without a SIGHUP dance.
    expect(body).toContain('copytruncate');
    expect(body).toContain('rotate ');
    expect(body).toContain('compress');
    expect(body).toContain('autopg-server-out.log');
    expect(body).toContain('autopg-server-error.log');
    expect(body).toContain('audit.log');
  });

  test('package.json files[] includes config/ so npm publish ships logrotate', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('config/');
  });
});
