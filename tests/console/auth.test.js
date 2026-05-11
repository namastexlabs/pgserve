'use strict';

const { test, expect, beforeEach, afterEach, describe } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// `cli-install.cjs` reads/writes admin.json via getConfigDir(), which honors
// AUTOPG_CONFIG_DIR. Each test gets a fresh tmpdir so password state from
// prior tests can't leak across cases.
let tmpHome;
let originalAutopgDir;
let originalDisableAuth;

describe('admin password gate', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-auth-'));
    originalAutopgDir = process.env.AUTOPG_CONFIG_DIR;
    originalDisableAuth = process.env.AUTOPG_DISABLE_AUTH;
    process.env.AUTOPG_CONFIG_DIR = tmpHome;
    // Default tests want auth ENABLED. Individual cases override.
    delete process.env.AUTOPG_DISABLE_AUTH;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (originalAutopgDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
    else process.env.AUTOPG_CONFIG_DIR = originalAutopgDir;
    if (originalDisableAuth === undefined) delete process.env.AUTOPG_DISABLE_AUTH;
    else process.env.AUTOPG_DISABLE_AUTH = originalDisableAuth;
  });

  test('ensureAdminPassword writes admin.json on first call, no-op on second', () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    delete require.cache[installPath];
    const install = require(installPath);
    const adminPath = install.getAdminFilePath();

    expect(fs.existsSync(adminPath)).toBe(false);

    const first = install._internals.ensureAdminPassword();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(20); // hex grouped → 24+ chars after dashes
    expect(fs.existsSync(adminPath)).toBe(true);

    // Mode 0600
    const stat = fs.statSync(adminPath);
    expect((stat.mode & 0o777).toString(8)).toBe('600');

    // Second call returns null (no rotation, no rewrite).
    const second = install._internals.ensureAdminPassword();
    expect(second).toBe(null);
  });

  test('verifyAdminPassword returns true for the right password, false for wrong', () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    delete require.cache[installPath];
    const install = require(installPath);

    const password = install._internals.ensureAdminPassword();
    expect(install.verifyAdminPassword(password)).toBe(true);
    expect(install.verifyAdminPassword('wrong-password')).toBe(false);
    expect(install.verifyAdminPassword('')).toBe(false);
  });

  test('rotate produces a different password and old one stops working', () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    delete require.cache[installPath];
    const install = require(installPath);

    const original = install._internals.ensureAdminPassword();
    expect(install.verifyAdminPassword(original)).toBe(true);

    const rotated = install._internals.ensureAdminPassword({ rotate: true });
    expect(rotated).not.toBe(original);
    expect(install.verifyAdminPassword(rotated)).toBe(true);
    expect(install.verifyAdminPassword(original)).toBe(false);

    const stored = install.readAdminFile();
    expect(stored.rotatedAt).not.toBe(null);
  });

  test('UI server returns 401 with WWW-Authenticate when no Basic Auth header', async () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
    delete require.cache[installPath];
    delete require.cache[uiPath];
    const install = require(installPath);
    install._internals.ensureAdminPassword();

    const ui = require(uiPath);
    const { port, close } = await ui.startServer({
      args: ['--no-open'],
      scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
      openInBrowser: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
    } finally {
      await close();
    }
  });

  test('UI server returns 200 with correct Basic Auth header', async () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
    delete require.cache[installPath];
    delete require.cache[uiPath];
    const install = require(installPath);
    const password = install._internals.ensureAdminPassword();

    const ui = require(uiPath);
    const { port, close } = await ui.startServer({
      args: ['--no-open'],
      scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
      openInBrowser: () => {},
    });
    try {
      const auth = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { authorization: auth },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('autopg · console');
    } finally {
      await close();
    }
  });

  test('UI server returns 401 for wrong password', async () => {
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
    delete require.cache[installPath];
    delete require.cache[uiPath];
    const install = require(installPath);
    install._internals.ensureAdminPassword();

    const ui = require(uiPath);
    const { port, close } = await ui.startServer({
      args: ['--no-open'],
      scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
      openInBrowser: () => {},
    });
    try {
      const auth = `Basic ${Buffer.from('admin:wrong-password').toString('base64')}`;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { authorization: auth },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('AUTOPG_DISABLE_AUTH=1 bypasses auth on loopback', async () => {
    process.env.AUTOPG_DISABLE_AUTH = '1';
    const installPath = path.join(REPO_ROOT, 'src', 'cli-install.cjs');
    const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
    delete require.cache[installPath];
    delete require.cache[uiPath];

    const ui = require(uiPath);
    const { port, close } = await ui.startServer({
      args: ['--no-open'],
      scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
      openInBrowser: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});
