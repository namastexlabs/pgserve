/**
 * Tests for src/cli-restart.cjs.
 *
 * Strategy:
 *   - Inject PM2 and readiness stubs through the dispatch context so tests
 *     exercise lifecycle decisions without touching the host supervisor.
 */

import { test, expect, describe } from 'bun:test';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function freshRestart() {
  const restartPath = path.join(REPO_ROOT, 'src', 'cli-restart.cjs');
  delete require.cache[restartPath];
  return require(restartPath);
}

describe('pm2 supervised path', () => {
  test('restarts the canonical autopg-server process and waits for readiness', async () => {
    const restart = freshRestart();
    let restartCalled = false;
    let requestedProcess = null;
    let readinessChecked = false;
    const code = await restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: (name) => {
        requestedProcess = name;
        return { name: 'autopg-server', pid: 1234 };
      },
      restartViaPm2: () => {
        restartCalled = true;
        return 0;
      },
      waitForServiceReadiness: async () => {
        readinessChecked = true;
        return { ready: true, status: 'ready' };
      },
    });
    expect(code).toBe(0);
    expect(requestedProcess).toBe('autopg-server');
    expect(restartCalled).toBe(true);
    expect(readinessChecked).toBe(true);
  });

  test('returns 1 when restartViaPm2 fails', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      scriptPath: 'unused',
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'autopg-server' }),
      restartViaPm2: () => 1,
    });
    expect(code).toBe(1);
  });

  test('returns 1 when the restarted process never becomes ready', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => true,
      pm2GetProcess: () => ({ name: 'autopg-server' }),
      restartViaPm2: () => 0,
      waitForServiceReadiness: async () => ({
        ready: false,
        status: 'degraded',
        supervisorStatus: 'online',
        runtimeLive: false,
        reasons: ['runtime process is not live'],
      }),
    });
    expect(code).toBe(1);
  });

  test('fails instead of spawning an unmanaged daemon when pm2 is unavailable', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => false,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(1);
  });

  test('fails instead of spawning an unmanaged daemon when the pm2 entry is missing', async () => {
    const restart = freshRestart();
    const code = await restart.dispatch([], {
      pm2IsAvailable: () => true,
      pm2GetProcess: () => null,
    });
    expect(code).toBe(1);
  });
});

describe('module helpers', () => {
  test('uses the canonical pm2 process name', () => {
    const restart = freshRestart();
    expect(restart._internals.PM2_PROCESS_NAME).toBe('autopg-server');
  });
});
