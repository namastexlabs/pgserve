/**
 * Tests for src/cli-install.cjs — pgserve install/uninstall/status/url/port.
 *
 * Wave 1 of the canonical-pgserve-pm2-supervision wish (PR #55, issue #56).
 *
 * Strategy: drive the pure paths (config read/write, arg parsing, pm2-args
 * builder) directly. The pm2-spawning paths (install / uninstall) are
 * exercised by spawning the real pgserve binary against a temp HOME so
 * `pm2` is invoked but with no real daemon side-effect when pm2 is
 * either absent OR the test stubs its calls via PATH.
 *
 * No test in this file actually starts pgserve. We only verify the CLI
 * surface — the daemon lifecycle is covered by daemon-control.test.js.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'pgserve-wrapper.cjs');

let tmpHome;
let stubBin;
let originalConfigDir;
let originalPath;

function makeStubPm2(mode = 'success') {
  // mode: 'success' | 'failure' | 'missing'
  // Writes a stub `pm2` script into a tempdir we prepend to PATH.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-stub-pm2-'));
  if (mode === 'missing') {
    // Don't create a stub; PATH still has our dir but no pm2 binary.
    return { dir, calls: [] };
  }
  const callLog = path.join(dir, 'calls.log');
  const exitCode = mode === 'failure' ? 1 : 0;
  // jlist returns either an empty list (so install proceeds) or a fake
  // process record (so subsequent install calls hit the idempotent
  // path). We toggle via a sentinel file the test owns.
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { process.stdout.write('5.0.0-stub\\n'); process.exit(0); }
if (args[0] === 'jlist') {
  const sentinel = ${JSON.stringify(path.join(dir, 'registered'))};
  if (fs.existsSync(sentinel)) {
    process.stdout.write(JSON.stringify([{
      name: 'pgserve',
      pid: 12345,
      pm2_env: { status: 'online', pm_uptime: Date.now() - 1000, restart_time: 0 }
    }]) + '\\n');
  } else {
    process.stdout.write('[]\\n');
  }
  process.exit(0);
}
if (args[0] === 'start') {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'registered'))}, '');
  process.exit(${exitCode});
}
if (args[0] === 'delete') {
  try { fs.unlinkSync(${JSON.stringify(path.join(dir, 'registered'))}); } catch {}
  process.exit(${exitCode});
}
process.exit(0);
`;
  const pm2Path = path.join(dir, 'pm2');
  fs.writeFileSync(pm2Path, script, { mode: 0o755 });
  return { dir, calls: callLog };
}

function readCallLog(callsPath) {
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runCli(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGSERVE_CONFIG_DIR: tmpHome,
      PATH: `${stubBin.dir}:${process.env.PATH}`,
      ...env,
    },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-cfg-'));
  stubBin = makeStubPm2('success');
  originalConfigDir = process.env.PGSERVE_CONFIG_DIR;
  originalPath = process.env.PATH;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (stubBin?.dir) fs.rmSync(stubBin.dir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.PGSERVE_CONFIG_DIR;
  else process.env.PGSERVE_CONFIG_DIR = originalConfigDir;
  process.env.PATH = originalPath;
});

describe('pgserve install', () => {
  test('first install registers under pm2 and writes config', () => {
    const result = runCli(['install']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installed');
    expect(result.stdout).toContain('postgres://localhost:8432');

    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(config.port).toBe(8432);
    expect(config.dataDir).toBe(path.join(tmpHome, 'data'));
    expect(config.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start');
    expect(startCall).toBeDefined();
    expect(startCall).toContain('--name');
    expect(startCall).toContain('pgserve');
    expect(startCall).toContain('--max-restarts');
    expect(startCall).toContain('50');
    // `--min-uptime` was removed in pm2 6.x — see cli-install.cjs comment.
    // Asserting NEGATIVELY ensures we don't reintroduce the flag and break
    // pgserve install on pm2@^6.0 again.
    expect(startCall).not.toContain('--min-uptime');
    expect(startCall).toContain('--exp-backoff-restart-delay');
    expect(startCall).toContain('--max-memory-restart');
    expect(startCall).toContain('4G');
    expect(startCall).toContain('--kill-timeout');
    expect(startCall).toContain('60000');
    expect(startCall).toContain('--interpreter');
    expect(startCall).toContain('none');
  });

  test('second install is idempotent (no second pm2 start)', () => {
    runCli(['install']);
    const calls1 = readCallLog(stubBin.calls);
    const startCount1 = calls1.filter((c) => c[0] === 'start').length;
    expect(startCount1).toBe(1);

    const result2 = runCli(['install']);
    expect(result2.status).toBe(0);
    expect(result2.stdout).toContain('already installed');

    const calls2 = readCallLog(stubBin.calls);
    const startCount2 = calls2.filter((c) => c[0] === 'start').length;
    expect(startCount2).toBe(1); // no second start
  });

  test('--port overrides default', () => {
    const result = runCli(['install', '--port', '8442']);
    expect(result.status).toBe(0);
    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, 'config.json'), 'utf8'));
    expect(config.port).toBe(8442);
    expect(result.stdout).toContain('postgres://localhost:8442');
  });

  test('rejects malformed --port', () => {
    const result = runCli(['install', '--port', 'not-a-number']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid --port');
  });

  test('PGSERVE_MAX_MEMORY env overrides the default memory ceiling', () => {
    const result = runCli(['install'], { PGSERVE_MAX_MEMORY: '8G' });
    expect(result.status).toBe(0);
    const calls = readCallLog(stubBin.calls);
    const startCall = calls.find((c) => c[0] === 'start');
    // The env value flows through to pm2's --max-memory-restart flag so
    // operators on big-iron hosts can tune up without a recompile.
    expect(startCall).toContain('8G');
    expect(startCall).not.toContain('4G');
  });

  test('fails clearly when pm2 is missing', () => {
    // Build a sanitized PATH that has node (so spawnSync can resolve the
    // interpreter) but explicitly NO directory containing pm2. Skipping
    // /usr/bin etc. would make the test brittle on different hosts.
    fs.rmSync(stubBin.dir, { recursive: true, force: true });
    stubBin = makeStubPm2('missing');
    const nodeDir = path.dirname(process.execPath);
    const sanitizedPath = (process.env.PATH || '')
      .split(':')
      .filter((p) => {
        try {
          return !fs.existsSync(path.join(p, 'pm2'));
        } catch {
          return true;
        }
      })
      .concat([nodeDir, stubBin.dir])
      .join(':');
    const result = spawnSync('node', [BIN, 'install'], {
      encoding: 'utf8',
      env: { ...process.env, PGSERVE_CONFIG_DIR: tmpHome, PATH: sanitizedPath },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('pm2 not found');
  });
});

describe('pgserve url / port', () => {
  test('url after install prints canonical connection string', () => {
    runCli(['install']);
    const result = runCli(['url']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('postgres://localhost:8432/postgres');
  });

  test('port after install prints the registered port', () => {
    runCli(['install', '--port', '8442']);
    const result = runCli(['port']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('8442');
  });

  test('url before install fails with helpful message', () => {
    const result = runCli(['url']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not installed');
  });
});

describe('pgserve status', () => {
  test('status before install reports installed=false (exit 1)', () => {
    const result = runCli(['status', '--json']);
    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout);
    expect(out.installed).toBe(false);
  });

  test('status after install reports running with port from config', () => {
    runCli(['install', '--port', '8482']);
    const result = runCli(['status', '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.installed).toBe(true);
    expect(out.name).toBe('pgserve');
    expect(out.status).toBe('online');
    expect(out.port).toBe(8482);
    expect(out.url).toBe('postgres://localhost:8482/postgres');
  });

  test('status human-readable output includes port + url', () => {
    runCli(['install']);
    const result = runCli(['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('port');
    expect(result.stdout).toContain('8432');
    expect(result.stdout).toContain('postgres://localhost:8432/postgres');
  });
});

describe('pgserve uninstall', () => {
  test('uninstall removes pm2 process but preserves config', () => {
    runCli(['install']);
    expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true);

    const result = runCli(['uninstall']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('uninstalled');

    const calls = readCallLog(stubBin.calls);
    expect(calls.find((c) => c[0] === 'delete' && c[1] === 'pgserve')).toBeDefined();

    // Config preserved so a re-install reuses port/dataDir.
    expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true);
  });

  test('uninstall when not installed is a no-op success', () => {
    const result = runCli(['uninstall']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not registered');
  });
});

describe('serve alias', () => {
  test('pgserve serve --help re-routes to daemon (which postgres-server.js handles)', () => {
    // We can't fully exercise `serve` without starting a real daemon.
    // Instead, verify the wrapper's argv-rewrite happens by passing
    // `serve --bogus-flag` and asserting the wrapper proceeded past the
    // install short-circuit (i.e. stderr mentions bun, not "pgserve: ...").
    // Note: bun probe might fail in tests; we don't assert exit code.
    const result = spawnSync('node', [BIN, 'serve', '--bogus-flag'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PGSERVE_CONFIG_DIR: tmpHome,
        PATH: `${stubBin.dir}:${process.env.PATH}`,
      },
    });
    // Must NOT have hit the install dispatcher (would print
    // "pgserve: not installed" or similar). Because serve passes through
    // to the bun + postgres-server.js path, we expect EITHER a bun error
    // OR a daemon-mode error — never an install-module error.
    expect(result.stderr).not.toContain('pgserve: not installed');
    expect(result.stderr).not.toContain('pm2 not found');
  });
});
