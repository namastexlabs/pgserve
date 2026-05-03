/**
 * Smoke tests: postinstall hook short-circuits on fresh install + skip flag.
 * Full integration tests (synthetic 2.1.3 → 2.2.x) live in tests/integration/upgrade-*.test.js (TBD).
 */

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTINSTALL = path.join(__dirname, '..', '..', 'scripts', 'postinstall.cjs');

test('postinstall: AUTOPG_SKIP_POSTINSTALL=1 short-circuits silently', () => {
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env: { ...process.env, AUTOPG_SKIP_POSTINSTALL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout.toString()).toBe('');
});

test('postinstall: fresh install (no data dir) exits 0 silently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autopg-test-'));
  const env = { ...process.env, AUTOPG_CONFIG_DIR: tmp };
  delete env.AUTOPG_SKIP_POSTINSTALL;
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('upgrade orchestrator: dry-run lists 6 steps without executing', async () => {
  const { upgrade, STEPS } = await import(path.join(__dirname, '..', '..', 'src', 'upgrade', 'index.js'));
  expect(STEPS.length).toBe(6);
  const r = await upgrade({ dryRun: true, quiet: true });
  expect(r.results.length).toBe(6);
  expect(r.results.every((x) => x.status === 'DRY-RUN')).toBe(true);
});
