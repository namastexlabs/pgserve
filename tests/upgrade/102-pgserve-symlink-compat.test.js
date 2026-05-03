/**
 * Tests for src/upgrade/steps/102-pgserve-symlink-compat.js — Group 3,
 * autopg-distribution-cutover wish.
 *
 * Pure filesystem test: drives every classification branch in a tempdir
 * acting as $HOME, no Postgres needed.
 *
 * Acceptance criterion covered (wish §Group 3):
 *   - `~/.pgserve` symlink exists and resolves to `~/.autopg` after
 *     upgrade.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as symlinkCompat from '../../src/upgrade/steps/102-pgserve-symlink-compat.js';

const noopLog = () => {};
const noopWarn = () => {};

let fakeHome;
let originalHome;
let stderrBuf;
let originalStderrWrite;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-symlink-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;

  stderrBuf = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrBuf.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (fakeHome && fs.existsSync(fakeHome)) {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

function legacy() { return path.join(fakeHome, '.pgserve'); }
function canonical() { return path.join(fakeHome, '.autopg'); }

describe('102-pgserve-symlink-compat — happy path', () => {
  test('creates the symlink when ~/.pgserve absent and ~/.autopg present', async () => {
    fs.mkdirSync(canonical(), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(canonical(), 'admin.secret'), 'secret\n', { mode: 0o600 });

    const planned = await symlinkCompat.plan();
    expect(planned).toMatch(/would symlink/);

    const r = await symlinkCompat.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/created symlink/);

    // Symlink exists and points at canonical.
    const stat = fs.lstatSync(legacy());
    expect(stat.isSymbolicLink()).toBe(true);
    const target = fs.readlinkSync(legacy());
    expect(path.resolve(target)).toBe(path.resolve(canonical()));

    // Reading through the symlink works.
    expect(fs.readFileSync(path.join(legacy(), 'admin.secret'), 'utf8')).toBe('secret\n');

    // Stderr deprecation hint was printed.
    const stderr = stderrBuf.join('');
    expect(stderr).toMatch(/DEPRECATION.*~\/\.pgserve.*symlink.*~\/\.autopg/);
  });

  test('rerun is SKIP when symlink already correct (idempotent)', async () => {
    fs.mkdirSync(canonical(), { mode: 0o700, recursive: true });
    fs.symlinkSync(canonical(), legacy());

    const planned = await symlinkCompat.plan();
    expect(planned).toMatch(/already.*no action/i);

    const r = await symlinkCompat.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('SKIP');

    // No deprecation hint on idempotent re-run.
    const stderr = stderrBuf.join('');
    expect(stderr).toBe('');
  });
});

describe('102-pgserve-symlink-compat — neither config dir present', () => {
  test('SKIP on a fresh untouched host', async () => {
    const planned = await symlinkCompat.plan();
    expect(planned).toMatch(/no action/i);

    const r = await symlinkCompat.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('SKIP');
    expect(r.detail).toMatch(/fresh host/i);
    expect(fs.existsSync(legacy())).toBe(false);
  });
});

describe('102-pgserve-symlink-compat — directory still exists', () => {
  test('preserves real ~/.pgserve directory next to ~/.autopg, prints deprecation', async () => {
    fs.mkdirSync(legacy(), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(legacy(), 'config.json'), '{}', { mode: 0o644 });
    fs.mkdirSync(canonical(), { mode: 0o700, recursive: true });

    const r = await symlinkCompat.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('SKIP');
    expect(r.detail).toMatch(/rollback safety/);

    // Legacy directory NOT replaced — caller must `rm -rf` manually.
    expect(fs.lstatSync(legacy()).isDirectory()).toBe(true);

    const stderr = stderrBuf.join('');
    expect(stderr).toMatch(/DEPRECATION/);
    expect(stderr).toMatch(/rm -rf/);
  });
});

describe('102-pgserve-symlink-compat — ordering errors', () => {
  test('FAILs if ~/.pgserve is a directory but ~/.autopg is missing', async () => {
    fs.mkdirSync(legacy(), { mode: 0o700, recursive: true });

    const r = await symlinkCompat.execute({ log: noopLog, warn: noopWarn });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toMatch(/missing.*settings-migrate/);
  });
});

describe('102-pgserve-symlink-compat — pre-existing wrong symlink', () => {
  test('does not touch a symlink pointing somewhere unexpected', async () => {
    const wrongTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-wrongtarget-'));
    fs.mkdirSync(canonical(), { mode: 0o700, recursive: true });
    fs.symlinkSync(wrongTarget, legacy());

    const warnings = [];
    const r = await symlinkCompat.execute({ log: noopLog, warn: (m) => warnings.push(m) });
    expect(r.status).toBe('SKIP');
    expect(warnings.some((m) => /unexpected target/i.test(m))).toBe(true);

    // Symlink still points at the wrong target — we did NOT clobber it.
    expect(path.resolve(fs.readlinkSync(legacy()))).toBe(path.resolve(wrongTarget));

    fs.rmSync(wrongTarget, { recursive: true, force: true });
  });
});

describe('102-pgserve-symlink-compat — module exports', () => {
  test('module exposes the canonical {name, plan, execute} step contract', () => {
    expect(symlinkCompat.name).toBe('pgserve-symlink-compat');
    expect(typeof symlinkCompat.plan).toBe('function');
    expect(typeof symlinkCompat.execute).toBe('function');
  });
});
