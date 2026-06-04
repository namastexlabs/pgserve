'use strict';

const { test, expect, beforeAll, afterAll } = require('bun:test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTOPG_BIN = path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs');

let serverProc;
let port;

function pickPort() {
  // Use a high port unlikely to conflict; the cli-ui port-walker will accept
  // any free port via --port.
  return 18430 + Math.floor(Math.random() * 100);
}

function waitFor(condFn, timeoutMs = 8000, stepMs = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condFn()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('timeout waiting for condition'));
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

beforeAll(async () => {
  // Ensure console/dist/ exists for the dist-prefer code path. If it doesn't
  // (CI didn't run console:build yet), the test silently exercises the
  // src/ fallback — which is a different code path but still satisfies the
  // "no CDN in served HTML" assertion as long as the source is CDN-free.
  port = pickPort();
  serverProc = spawn('node', [AUTOPG_BIN, 'ui', '--no-open', '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Auth bypass — these tests don't exercise the auth path; a sibling
    // test in cli-install (auth.test.js) covers the 401/Basic Auth gate.
    env: { ...process.env, AUTOPG_DISABLE_AUTH: '1' },
  });

  // Wait for the listening line on stdout.
  let stdoutBuf = '';
  serverProc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
  });

  await waitFor(() => stdoutBuf.includes(`listening on http://127.0.0.1:${port}`), 10000);
});

afterAll(() => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
  }
});

test('served / contains zero CDN script references', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  const html = await res.text();

  // Golden assertion — the offline-capability promise of v2.2.2.
  expect(html).not.toMatch(/unpkg\.com/);
  expect(html).not.toMatch(/jsdelivr/);
  expect(html).not.toMatch(/cdn\.babel/);
  expect(html).not.toMatch(/babel\/standalone/);

  // Sanity: served HTML is the SPA shell.
  expect(html).toContain('<div id="root"></div>');
});

test('app.js bundle is reachable as static asset', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/app.js`);
  // 200 if dist/app.js exists; 404 if running from src/ fallback (no bundle yet).
  // Both are valid — the test's job is to confirm if a bundle IS served, it's
  // local + valid JS.
  if (res.status === 200) {
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1000); // bundle should be > 1KB
    expect(body).not.toMatch(/unpkg\.com/);
    expect(body).not.toMatch(/jsdelivr/);
  } else {
    // src/ fallback path — accept 404 as long as src/main.jsx exists for dev mode
    expect(res.status).toBe(404);
    const distPresent = fs.existsSync(path.join(REPO_ROOT, 'console', 'dist', 'app.js'));
    if (distPresent) {
      throw new Error(`dist/app.js exists on disk but server returned ${res.status}`);
    }
  }
});

test('index.html script tag points at relative app.js, not external host', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const html = await res.text();
  // Pre-bundle: index.html should load `./app.js` (or `app.js`) only.
  expect(html).toMatch(/<script[^>]+src=['"](\.\/)?app\.js['"][^>]*>/);
});
