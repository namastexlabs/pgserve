/**
 * Stale postmaster.pid cleanup
 *
 * Verifies that PostgresManager._ensureNoStalePostmasterLock removes
 * a postmaster.pid file whose recorded PID is no longer alive, and
 * leaves alone a postmaster.pid whose recorded PID is alive.
 *
 * Regression coverage: postgres refuses to start when postmaster.pid
 * exists, even if the writer crashed. After unclean shutdowns this
 * required manual `rm` to recover.
 */

import { PostgresManager } from '../src/postgres.js';
import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeMgr(dataDir) {
  const mgr = new PostgresManager({ dataDir });
  mgr.databaseDir = dataDir;
  mgr.logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return mgr;
}

function makePidFile(dir, contents) {
  fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, 'postmaster.pid');
  fs.writeFileSync(pidFile, contents, 'utf-8');
  return pidFile;
}

test('removes postmaster.pid when recorded PID is dead', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-stale-'));
  try {
    // PID 999999999 will not exist on any sane system
    const pidFile = makePidFile(dir, '999999999\n/some/data\n123\n');
    const mgr = makeMgr(dir);
    await mgr._ensureNoStalePostmasterLock();
    expect(fs.existsSync(pidFile)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps postmaster.pid when recorded PID is the current (alive) process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-alive-'));
  try {
    const pidFile = makePidFile(dir, `${process.pid}\n/some/data\n123\n`);
    const mgr = makeMgr(dir);
    await mgr._ensureNoStalePostmasterLock();
    expect(fs.existsSync(pidFile)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removes postmaster.pid when first line is unparseable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-garbage-'));
  try {
    const pidFile = makePidFile(dir, 'garbage\nnot-a-pid\n');
    const mgr = makeMgr(dir);
    await mgr._ensureNoStalePostmasterLock();
    expect(fs.existsSync(pidFile)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no-ops when postmaster.pid does not exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-missing-'));
  try {
    const mgr = makeMgr(dir);
    // Should resolve without throwing
    await mgr._ensureNoStalePostmasterLock();
    expect(fs.existsSync(path.join(dir, 'postmaster.pid'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
