/**
 * Tests for src/cli-restart.cjs.
 *
 * Strategy:
 *   - For pm2-supervised paths, inject pm2IsAvailable / pm2GetProcess /
 *     restartViaPm2 stubs via the dispatch ctx — this avoids depending on
 *     PATH propagation through bun test's subprocess machinery.
 *   - For local respawn we point XDG_RUNTIME_DIR at a tempdir, drop a
 *     pidfile pointing at a real subprocess we control, and assert the
 *     SIGTERM + respawn flow.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let tmpDir;
let originalXdg;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-restart-'));
  originalXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalXdg;
});

function freshRestart() {
  const restartPath = path.join(REPO_ROOT, 'src', 'cli-restart.cjs');
  delete require.cache[restartPath];
  return require(restartPath);
}

describe('pm2 supervised path', () => {
  test('calls restartViaPm2 when pm2 is available and process is registered', () => {
    const restart = freshRestart();
    let restartCalled = false;
    const code = restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'pgserve', pid: 1234 }),
      restartViaPm2: () => {
        restartCalled = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(restartCalled).toBe(true);
  });

  test('returns 1 when restartViaPm2 fails', () => {
    const restart = freshRestart();
    const code = restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'pgserve' }),
      restartViaPm2: () => 1,
    });
    expect(code).toBe(1);
  });

  test('falls through to local respawn when pm2 is missing', () => {
    const restart = freshRestart();
    const stubWrapper = path.join(tmpDir, 'wrapper.cjs');
    fs.writeFileSync(stubWrapper, "process.exit(0);\n", { mode: 0o755 });
    const code = restart.dispatch([], {
      scriptPath: stubWrapper,
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(0);
  });

  test('falls through to local respawn when pm2 has no pgserve process', () => {
    const restart = freshRestart();
    const stubWrapper = path.join(tmpDir, 'wrapper.cjs');
    fs.writeFileSync(stubWrapper, "process.exit(0);\n", { mode: 0o755 });
    const code = restart.dispatch([], {
      scriptPath: stubWrapper,
      pm2IsAvailable: () => true,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(0);
  });
});

describe('local respawn path', () => {
  test('respawns directly when no pidfile is present', () => {
    const restart = freshRestart();
    const stubWrapper = path.join(tmpDir, 'wrapper.cjs');
    fs.writeFileSync(stubWrapper, "process.exit(0);\n", { mode: 0o755 });
    const code = restart.dispatch([], {
      scriptPath: stubWrapper,
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(0);
  });

  test('errors with code 1 when wrapper script is missing', () => {
    const restart = freshRestart();
    const code = restart.dispatch([], {
      scriptPath: '/nonexistent/wrapper.cjs',
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(1);
  });

  test('signals SIGTERM to the daemon pid in the pidfile and respawns', async () => {
    const pidDir = path.join(tmpDir, 'pgserve');
    fs.mkdirSync(pidDir, { recursive: true });
    const pidPath = path.join(pidDir, 'pgserve.pid');

    // Spawn a subprocess that handles SIGTERM by removing its pidfile —
    // mirrors what the real daemon does on graceful shutdown.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const fs = require('fs');
        const pidPath = ${JSON.stringify(pidPath)};
        fs.writeFileSync(pidPath, String(process.pid));
        process.on('SIGTERM', () => {
          try { fs.unlinkSync(pidPath); } catch {}
          process.exit(0);
        });
        setInterval(() => {}, 1000);
        `,
      ],
      { stdio: 'ignore' },
    );

    // Wait for the pidfile to be written.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(pidPath)).toBe(true);

    const stubWrapper = path.join(tmpDir, 'wrapper.cjs');
    fs.writeFileSync(stubWrapper, "process.exit(0);\n", { mode: 0o755 });

    const restart = freshRestart();
    const code = restart.dispatch([], {
      scriptPath: stubWrapper,
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(0);

    // Give the child a moment to clean up, then verify SIGTERM landed.
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(pidPath)).toBe(false);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  });
});

describe('module helpers', () => {
  test('readPid handles missing file', () => {
    const restart = freshRestart();
    expect(restart._internals.readPid('/nonexistent/pidfile')).toBe(null);
  });

  test('readPid handles malformed contents', () => {
    const malformed = path.join(tmpDir, 'bad.pid');
    fs.writeFileSync(malformed, 'not a number');
    const restart = freshRestart();
    expect(restart._internals.readPid(malformed)).toBe(null);
  });

  test('readPid returns the integer pid on a valid file', () => {
    const good = path.join(tmpDir, 'good.pid');
    fs.writeFileSync(good, '12345\n');
    const restart = freshRestart();
    expect(restart._internals.readPid(good)).toBe(12345);
  });

  test('isAlive reports true for current process and false for absurd pids', () => {
    const restart = freshRestart();
    expect(restart._internals.isAlive(process.pid)).toBe(true);
    // Pid 0 is "process group" on POSIX so we use a very large number that
    // won't be assigned. EPERM would still report alive (rare here).
    expect(restart._internals.isAlive(2147483646)).toBe(false);
  });
});
