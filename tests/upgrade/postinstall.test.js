/**
 * Smoke test: postinstall hook short-circuits on fresh install + skip flag.
 * Full integration tests (synthetic 2.1.3 → 2.2.x migration, no-op idempotence)
 * require pg fixtures and live in tests/integration/upgrade-*.test.js (TBD).
 */

const { test, expect } = require('bun:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
  const r = spawnSync(process.execPath, [POSTINSTALL], {
    env: { ...process.env, AUTOPG_CONFIG_DIR: tmp, AUTOPG_SKIP_POSTINSTALL: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('upgrade orchestrator: dry-run lists 6 steps without executing', async () => {
  const { upgrade, STEPS } = require(path.join(__dirname, '..', '..', 'src', 'upgrade'));
  expect(STEPS.length).toBe(6);
  // dry-run should not throw and should report all steps
  const r = await upgrade({ dryRun: true, quiet: true });
  expect(r.results.length).toBe(6);
  expect(r.results.every((x) => x.status === 'DRY-RUN')).toBe(true);
});
