/**
 * Tests for src/fingerprint.js — kernel-rooted peer identity.
 *
 * Coverage:
 *  - getPeerCred() returns the calling process's pid/uid/gid via SO_PEERCRED
 *  - findNearestPackageJson() walks upward; deepest match wins (monorepo)
 *  - derivePackageFingerprint() is stable across cwd changes in the same project
 *  - same name + different paths → different fingerprints
 *  - same path + different uid → different fingerprints
 *  - script fallback triggers when no package.json above cwd
 *  - end-to-end: handleControlAccept() emits a connection_routed audit entry
 */

import { test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import {
  initFingerprintFfi,
  getPeerCred,
  findNearestPackageJson,
  readPackageName,
  derivePackageFingerprint,
  deriveScriptFingerprint,
  fingerprintFromCred,
  handleControlAccept,
  _setPeerCredImpl,
} from '../src/fingerprint.js';
import { configureAudit, AUDIT_EVENTS } from '../src/audit.js';

let scratch;

beforeAll(async () => {
  await initFingerprintFfi();
});

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pgserve-fp-test-'));
  configureAudit({
    logFile: path.join(scratch, 'audit.log'),
    target: 'file',
  });
});

afterEach(() => {
  _setPeerCredImpl(null);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// SO_PEERCRED smoke — proves the FFI path works end-to-end on this kernel.
// ---------------------------------------------------------------------------

test('getPeerCred reads kernel-attested pid/uid/gid via Unix socket pair', async () => {
  const sockPath = path.join(scratch, 'peer.sock');
  const expectedUid = process.getuid();
  const expectedGid = process.getgid();
  const expectedPid = process.pid;

  const cred = await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      try {
        const c = getPeerCred(socket);
        socket.end();
        server.close(() => resolve(c));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
    server.on('error', reject);
    server.listen(sockPath, () => {
      const client = net.createConnection(sockPath);
      client.on('error', reject);
    });
  });

  expect(cred.pid).toBe(expectedPid);
  expect(cred.uid).toBe(expectedUid);
  expect(cred.gid).toBe(expectedGid);
});

// ---------------------------------------------------------------------------
// Pure-function tests on derivation surface
// ---------------------------------------------------------------------------

test('fingerprint stable across cwd change in the same project', () => {
  // Layout:
  //   <scratch>/proj/package.json (name=alpha)
  //   <scratch>/proj/sub/deep/
  // Same project → same fingerprint regardless of starting cwd.
  const proj = path.join(scratch, 'proj');
  fs.mkdirSync(path.join(proj, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'alpha' }));

  const root = findNearestPackageJson(proj);
  const fromSub = findNearestPackageJson(path.join(proj, 'sub'));
  const fromDeep = findNearestPackageJson(path.join(proj, 'sub', 'deep'));

  expect(root).not.toBeNull();
  expect(fromSub).toBe(root);
  expect(fromDeep).toBe(root);

  const fp1 = derivePackageFingerprint({ packageRealpath: root, name: 'alpha', uid: 1000 });
  const fp2 = derivePackageFingerprint({ packageRealpath: fromSub, name: 'alpha', uid: 1000 });
  const fp3 = derivePackageFingerprint({ packageRealpath: fromDeep, name: 'alpha', uid: 1000 });
  expect(fp1).toBe(fp2);
  expect(fp2).toBe(fp3);
  expect(fp1).toMatch(/^[0-9a-f]{12}$/);
});

test('two projects with the same name but different paths get different fingerprints', () => {
  const a = path.join(scratch, 'a-project');
  const b = path.join(scratch, 'b-project');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'package.json'), JSON.stringify({ name: 'shared' }));
  fs.writeFileSync(path.join(b, 'package.json'), JSON.stringify({ name: 'shared' }));

  const pa = findNearestPackageJson(a);
  const pb = findNearestPackageJson(b);
  expect(pa).not.toBe(pb);

  const fpa = derivePackageFingerprint({ packageRealpath: pa, name: 'shared', uid: 1000 });
  const fpb = derivePackageFingerprint({ packageRealpath: pb, name: 'shared', uid: 1000 });
  expect(fpa).not.toBe(fpb);
});

test('same path + different uid → different fingerprints', () => {
  const proj = path.join(scratch, 'multi-user');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'multi' }));
  const realpath = findNearestPackageJson(proj);

  const fp1000 = derivePackageFingerprint({ packageRealpath: realpath, name: 'multi', uid: 1000 });
  const fp1001 = derivePackageFingerprint({ packageRealpath: realpath, name: 'multi', uid: 1001 });
  expect(fp1000).not.toBe(fp1001);
});

test('script fallback triggered when no package.json above cwd', () => {
  // Build an isolated path tree under scratch with no package.json anywhere.
  // We point fingerprintFromCred at an override cwd inside scratch so the
  // upward walk hits the filesystem root (no package.json in /tmp/.. either,
  // because we use a deliberately ephemeral dir tree owned by the test).
  const isolated = path.join(scratch, 'isolated', 'deep');
  fs.mkdirSync(isolated, { recursive: true });

  // Sanity: walking up from `isolated` finds no package.json (until at least
  // /tmp/... or higher; we trust the host doesn't have one in /tmp).
  // If the host *does* have one above /tmp, the result would still be deterministic
  // and correct (mode='package'), but we want to test the script-fallback branch
  // here. Mock findNearestPackageJson by passing a cwdOverride beneath a fake
  // chroot — the easiest way is to walk to a path that we control: use an
  // empty subtree under scratch and pretend the walk has hit the root.
  const sentinelFile = findNearestPackageJson(isolated);
  // If the host has no package.json anywhere up to /, sentinelFile is null.
  // If it does, this assertion would falsely target the host's package.json.
  // To make the test deterministic, we drive the script branch directly via
  // deriveScriptFingerprint; the integration of "no package.json found" is
  // covered by fingerprintFromCred's branch logic with cmdlineOverride.

  const fp = deriveScriptFingerprint({
    uid: 1000,
    cwd: '/some/orphan/dir',
    cmdline1: '/usr/local/bin/foo.js',
  });
  expect(fp).toMatch(/^[0-9a-f]{12}$/);

  // Also verify fingerprintFromCred picks the script branch when cwdOverride
  // points at a path with no ancestor package.json — we use a path under
  // scratch since scratch itself has no package.json, and we pass cmdlineOverride.
  const info = fingerprintFromCred(
    { pid: 9999, uid: 1000, gid: 1000 },
    {
      cwdOverride: isolated,
      cmdlineOverride: ['/usr/local/bin/bun', '/some/orphan/dir/foo.js'],
    },
  );
  // sentinelFile may be null (script mode) or non-null (if host has /package.json upstream).
  if (sentinelFile === null) {
    expect(info.mode).toBe('script');
    expect(info.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(info.packageRealpath).toBeNull();
  } else {
    // Host has an ancestor package.json. Still verify that derivation produces
    // a 12-hex value and that the 'package' branch was chosen — the
    // script-fallback behavior is independently exercised by deriveScriptFingerprint above.
    expect(info.mode).toBe('package');
    expect(info.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  }
});

test('monorepo: nested package.json wins (deepest match)', () => {
  // Layout:
  //   <scratch>/mono/package.json           (name=workspace-root)
  //   <scratch>/mono/packages/api/package.json (name=api)
  //   <scratch>/mono/packages/api/src/
  // Walking up from src/ must find the api package.json, not the workspace root.
  const root = path.join(scratch, 'mono');
  const api = path.join(root, 'packages', 'api');
  const apiSrc = path.join(api, 'src');
  fs.mkdirSync(apiSrc, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'workspace-root' }));
  fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ name: 'api' }));

  const found = findNearestPackageJson(apiSrc);
  expect(found).toBe(fs.realpathSync(path.join(api, 'package.json')));
  expect(readPackageName(found)).toBe('api');

  const info = fingerprintFromCred(
    { pid: 9999, uid: 1000, gid: 1000 },
    { cwdOverride: apiSrc, cmdlineOverride: ['bun', 'src/index.js'] },
  );
  expect(info.mode).toBe('package');
  expect(info.name).toBe('api');
  expect(info.packageRealpath).toBe(found);
});

// ---------------------------------------------------------------------------
// End-to-end: handleControlAccept emits connection_routed
// ---------------------------------------------------------------------------

test('handleControlAccept emits a connection_routed audit event with 12-hex fingerprint', () => {
  const proj = path.join(scratch, 'audit-target');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'audit-app' }));

  // Stub peer-cred impl so we don't need a real socket.
  _setPeerCredImpl(() => ({ pid: 4242, uid: 1000, gid: 1000 }));

  const info = handleControlAccept(
    { /* fake socket */ },
    { cwdOverride: proj, cmdlineOverride: ['bun', 'index.js'] },
  );

  expect(info.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  expect(info.mode).toBe('package');
  expect(info.name).toBe('audit-app');

  const logFile = path.join(scratch, 'audit.log');
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0]);
  expect(entry.event).toBe(AUDIT_EVENTS.CONNECTION_ROUTED);
  expect(entry.fingerprint).toBe(info.fingerprint);
  expect(entry.peer_pid).toBe(4242);
  expect(entry.peer_uid).toBe(1000);
  expect(entry.mode).toBe('package');
});
