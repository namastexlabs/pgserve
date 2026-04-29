import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildDaemonArgs,
  daemonClientOptions,
  probeDaemon,
  resolveLibpqCompatPath,
  resolvePidLockPath,
} from '../src/index.js';

function makeDir(tag) {
  const dir = path.join(os.tmpdir(), `pgserve-sdk-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe('SDK daemon helpers', () => {
  test('daemonClientOptions returns libpq socket connection settings', () => {
    expect(daemonClientOptions({ controlSocketDir: '/tmp/pgserve' })).toEqual({
      host: '/tmp/pgserve',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
      password: '',
    });
  });

  test('buildDaemonArgs exposes persistent, pgvector, and listen options', () => {
    expect(buildDaemonArgs({
      dataDir: '/var/lib/pgserve',
      logLevel: 'warn',
      pgvector: true,
      listens: ['127.0.0.1:15432'],
    })).toEqual([
      'daemon',
      '--data',
      '/var/lib/pgserve',
      '--log',
      'warn',
      '--pgvector',
      '--listen',
      '127.0.0.1:15432',
    ]);
  });

  test('probeDaemon reports missing and stale daemon state', () => {
    const dir = makeDir('probe');
    try {
      expect(probeDaemon({ controlSocketDir: dir })).toMatchObject({
        running: false,
        pid: null,
        reason: 'no daemon',
      });

      fs.writeFileSync(resolvePidLockPath(dir), '999999', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'control.sock'), '');
      fs.symlinkSync('control.sock', resolveLibpqCompatPath(dir));
      expect(probeDaemon({ controlSocketDir: dir })).toMatchObject({
        running: false,
        pid: null,
        libpqSocketPresent: true,
        reason: 'stale pid',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
