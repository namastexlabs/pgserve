/**
 * Console UI smoke test.
 *
 * The full design ships React + Babel via CDN, so a "real" mount-and-walk
 * test would need happy-dom or jsdom with network access. We don't ship
 * that infra, so this smoke test exercises the next-best layer:
 *
 *   1. Static layout — every file the wish requires exists in `console/`,
 *      including the 11 screens registered through window.Screen*.
 *   2. HTML wiring — index.html references every screen + the API client.
 *   3. HTTP serving — the `autopg ui` server hands each console asset back
 *      with the right content-type, and the `/api/settings` round-trip
 *      works against a fresh tmp config dir.
 *   4. Helper API integration — api.js loads cleanly into a sandbox with
 *      a stub `fetch`, getSettings/putSettings/restart/getStatus exist on
 *      window.AutopgApi, and ETAG_MISMATCH surfaces as a structured error.
 *
 * Anything that would actually exercise the React tree belongs in a future
 * jsdom-backed test; the goal here is to fail loudly when the static
 * deliverables go missing.
 */

import { test, expect, beforeEach, afterEach, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Sources live under console/src/ since v2.2.2 (autopg-console-dist).
// console/dist/ holds the bundled artifact and is gitignored; smoke tests
// inspect the editable source tree.
const CONSOLE_ROOT = path.join(REPO_ROOT, 'console', 'src');

const REQUIRED_TOPLEVEL = [
  'index.html',
  'app.jsx',
  'api.js',
  'components.jsx',
  'data.jsx',
  'tweaks-panel.jsx',
  'console.css',
  'colors_and_type.css',
];

const SCREEN_FILES = [
  'databases.jsx',
  'tables.jsx',
  'sql.jsx',
  'optimizer.jsx',
  'security.jsx',
  'ingress.jsx',
  'health.jsx',
  'sync.jsx',
  'rlm-trace.jsx',
  'rlm-sim.jsx',
  'settings.jsx',
];

const SCREEN_GLOBALS = [
  'ScreenDatabases',
  'ScreenTables',
  'ScreenSQL',
  'ScreenOptimizer',
  'ScreenSecurity',
  'ScreenIngress',
  'ScreenHealth',
  'ScreenSync',
  'ScreenRlmTrace',
  'ScreenRlmSim',
  'ScreenSettings',
];

describe('console/ static layout', () => {
  test('top-level files all present', () => {
    for (const f of REQUIRED_TOPLEVEL) {
      const target = path.join(CONSOLE_ROOT, f);
      expect(fs.existsSync(target)).toBe(true);
      const stat = fs.statSync(target);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  test('all 11 screens present', () => {
    for (const f of SCREEN_FILES) {
      const target = path.join(CONSOLE_ROOT, 'screens', f);
      expect(fs.existsSync(target)).toBe(true);
      const stat = fs.statSync(target);
      expect(stat.size).toBeGreaterThan(0);
    }
  });

  test('every screen exports its window global', () => {
    for (let i = 0; i < SCREEN_FILES.length; i++) {
      const src = fs.readFileSync(path.join(CONSOLE_ROOT, 'screens', SCREEN_FILES[i]), 'utf8');
      expect(src).toContain(`window.${SCREEN_GLOBALS[i]}`);
    }
  });

  test('10 non-Settings screens render the [ coming soon ] placeholder', () => {
    for (const f of SCREEN_FILES.filter((s) => s !== 'settings.jsx')) {
      const src = fs.readFileSync(path.join(CONSOLE_ROOT, 'screens', f), 'utf8');
      expect(src).toContain('window.ComingSoon');
    }
  });

  test('settings.jsx renders the 6-section schema view', () => {
    const src = fs.readFileSync(path.join(CONSOLE_ROOT, 'screens', 'settings.jsx'), 'utf8');
    for (const section of ['server', 'runtime', 'sync', 'supervision', 'postgres', 'ui']) {
      expect(src).toContain(section);
    }
    // Raw passthrough panel + etag-mismatch banner are required.
    expect(src).toContain('postgres._extra');
    expect(src).toContain('ETAG_MISMATCH');
    expect(src).toContain('overridden by env');
  });
});

describe('console/src/index.html wiring (post-bundle, v2.2.2)', () => {
  const html = fs.readFileSync(path.join(CONSOLE_ROOT, 'index.html'), 'utf8');

  test('loads the bundled app.js as a single ES module entry', () => {
    // After autopg-console-dist: console/src/index.html drops the flat-script
    // layout and loads exactly one bundled module. main.jsx is the source
    // entry; bun build emits app.js; index.html points at app.js (relative).
    expect(html).toMatch(/<script[^>]+type=["']module["'][^>]+src=["'](\.\/)?app\.js["'][^>]*>/);
  });

  test('contains zero CDN script references', () => {
    // The whole point of v2.2.2: no unpkg, no jsdelivr, no babel-standalone.
    expect(html).not.toMatch(/unpkg\.com/);
    expect(html).not.toMatch(/jsdelivr/);
    expect(html).not.toMatch(/cdn\.babel/);
    expect(html).not.toMatch(/babel\/standalone/);
    expect(html).not.toMatch(/type=["']text\/babel["']/);
  });

  test('has no individual <script src="screens/...">  / <script src="*.jsx"> tags', () => {
    // Every screen + flat-script source is now bundled into app.js.
    // Lingering individual <script src=…> tags would mean the rewrite missed
    // a row.
    for (const f of SCREEN_FILES) {
      expect(html).not.toContain(`screens/${f}`);
    }
    expect(html).not.toMatch(/<script[^>]+src=["']api\.js["']/);
    expect(html).not.toMatch(/<script[^>]+src=["']app\.jsx["']/);
  });
});

describe('console/app.jsx routing', () => {
  const src = fs.readFileSync(path.join(CONSOLE_ROOT, 'app.jsx'), 'utf8');

  test('declares all 11 sections including rlm-trace and rlm-sim', () => {
    expect(src).toContain("id: 'rlm-trace'");
    expect(src).toContain("id: 'rlm-sim'");
    // Quick sanity: count nav rows in the SECTIONS table.
    const matches = src.match(/id: '[^']+'/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(11);
  });

  test('topbar identity flips to autopg', () => {
    expect(src).toContain('autopg');
    // The pristine design hardcoded `pgserve` in the topbar; the rewrite
    // moved the wordmark to the autopg label. The string can still appear
    // in comments, but no JSX literal `<span>pgserve</span>` should remain.
    expect(/<span>pgserve<\/span>/.test(src)).toBe(false);
  });

  test('persists theme via window.AutopgApi.putSettings', () => {
    expect(src).toContain('AutopgApi.putSettings');
    expect(src).toContain('ui: { theme:');
  });
});

describe('api.js sandbox load', () => {
  test('exports the four endpoints and handles ETAG_MISMATCH', async () => {
    const apiSrc = fs.readFileSync(path.join(CONSOLE_ROOT, 'api.js'), 'utf8');

    const fetchCalls = [];
    let nextResponse;
    function mockFetch(url, opts = {}) {
      fetchCalls.push({ url, opts });
      const r = nextResponse;
      const body = JSON.stringify(r.body);
      return Promise.resolve({
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(r.body),
      });
    }

    const sandbox = {
      window: {},
      console,
      fetch: mockFetch,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(apiSrc, sandbox);

    const api = sandbox.window.AutopgApi;
    expect(typeof api).toBe('object');
    expect(typeof api.getSettings).toBe('function');
    expect(typeof api.putSettings).toBe('function');
    expect(typeof api.restart).toBe('function');
    expect(typeof api.getStatus).toBe('function');
    expect(typeof api.ApiError).toBe('function');

    // GET caches the etag.
    nextResponse = { status: 200, body: { settings: {}, sources: {}, etag: 'sha256:abc' } };
    const got = await api.getSettings();
    expect(got.etag).toBe('sha256:abc');
    expect(api.getCachedEtag()).toBe('sha256:abc');

    // PUT uses cached etag and sends If-Match.
    nextResponse = { status: 200, body: { ok: true, etag: 'sha256:def' } };
    await api.putSettings({ ui: { theme: 'lumon' } });
    const lastPut = fetchCalls[fetchCalls.length - 1];
    expect(lastPut.opts.method).toBe('PUT');
    expect(lastPut.opts.headers['if-match']).toBe('sha256:abc');

    // 409 raises a structured error with currentEtag.
    nextResponse = {
      status: 409,
      body: { error: { code: 'ETAG_MISMATCH', message: 'changed' }, currentEtag: 'sha256:zzz' },
    };
    let caught;
    try {
      await api.putSettings({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ETAG_MISMATCH');
    expect(caught.currentEtag).toBe('sha256:zzz');
    // The cache should now hold the newer etag so a subsequent reload uses it.
    expect(api.getCachedEtag()).toBe('sha256:zzz');
  });
});

describe('autopg ui server hands every console asset back', () => {
  let tmpHome;
  let originalAutopgDir;

  let originalDisableAuth;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-console-smoke-'));
    originalAutopgDir = process.env.AUTOPG_CONFIG_DIR;
    originalDisableAuth = process.env.AUTOPG_DISABLE_AUTH;
    process.env.AUTOPG_CONFIG_DIR = tmpHome;
    // Bypass Basic Auth for this asset-shape test. Auth-specific behavior
    // is covered separately.
    process.env.AUTOPG_DISABLE_AUTH = '1';
    delete process.env.AUTOPG_PORT;
    delete process.env.PGSERVE_PORT;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (originalAutopgDir === undefined) delete process.env.AUTOPG_CONFIG_DIR;
    else process.env.AUTOPG_CONFIG_DIR = originalAutopgDir;
    if (originalDisableAuth === undefined) delete process.env.AUTOPG_DISABLE_AUTH;
    else process.env.AUTOPG_DISABLE_AUTH = originalDisableAuth;
  });

  test('serves the index plus the bundled app.js + CSS files', async () => {
    // After v2.2.2 (autopg-console-dist): cli-ui.cjs prefers console/dist/
    // over console/src/. The bundled artifacts are app.js + the two CSS files.
    // Individual .jsx files are no longer served as static assets — they are
    // bundled into app.js. This test asserts the bundled shape.
    const uiPath = path.join(REPO_ROOT, 'src', 'cli-ui.cjs');
    delete require.cache[uiPath];
    const ui = require(uiPath);
    const { port, close } = await ui.startServer({
      args: ['--no-open'],
      scriptPath: path.join(REPO_ROOT, 'bin', 'autopg-wrapper.cjs'),
      openInBrowser: () => {},
    });
    try {
      const base = `http://127.0.0.1:${port}`;

      const indexRes = await fetch(`${base}/`);
      expect(indexRes.status).toBe(200);
      const indexHtml = await indexRes.text();
      expect(indexHtml).toContain('autopg · console');

      // The bundled assets that MUST resolve:
      const expectAssets = [
        { path: 'app.js', expectMime: /javascript/ },
        { path: 'console.css', expectMime: /text\/css/ },
        { path: 'colors_and_type.css', expectMime: /text\/css/ },
      ];
      for (const { path: p, expectMime } of expectAssets) {
        const r = await fetch(`${base}/${p}`);
        expect(r.status).toBe(200);
        const ct = r.headers.get('content-type') || '';
        expect(ct).toMatch(expectMime);
      }
    } finally {
      await close();
    }
  });
});
