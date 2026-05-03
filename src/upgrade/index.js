/**
 * autopg upgrade — idempotent migration orchestrator.
 *
 * Runs 6 steps in order, each safe to re-run any number of times:
 *   1. port-reconcile    — ensure pgserve listens on canonical port (8432)
 *   2. binary-cache-flush — verify binary version matches PINNED_PG_VERSION
 *   3. plpgsql-resolve   — DROP+CREATE plpgsql per DB to refresh .so path
 *   4. env-refresh       — regenerate ~/.autopg/<app>.env URLs
 *   5. consumer-signal   — touch ~/.autopg/state/upgrade.signal
 *   6. health-validate   — pg_isready + per-DB plpgsql smoke test
 *
 * Patches the upgrade-path hole left by autopg-v22 partial roll-out:
 * users running pgserve@2.1.x → autopg@2.2.x get transparent migration.
 *
 * See: .genie/wishes/autopg-upgrade-command/WISH.md
 */

const { runStep } = require('./runner');

const STEPS = [
  { name: 'port-reconcile', module: './steps/port-reconcile' },
  { name: 'binary-cache-flush', module: './steps/binary-cache-flush' },
  { name: 'plpgsql-resolve', module: './steps/plpgsql-resolve' },
  { name: 'env-refresh', module: './steps/env-refresh' },
  { name: 'consumer-signal', module: './steps/consumer-signal' },
  { name: 'health-validate', module: './steps/health-validate' },
];

/**
 * Run upgrade. Options:
 *   - quiet   (bool): suppress per-step OK lines; only print summary + warnings
 *   - dryRun  (bool): print planned actions without executing
 *   - skipSteps (string[]): step names to skip (testing / partial recovery)
 */
async function upgrade(options = {}) {
  const { quiet = false, dryRun = false, skipSteps = [] } = options;
  const log = (msg) => { if (!quiet) process.stderr.write(`${msg}\n`); };
  const warn = (msg) => process.stderr.write(`${msg}\n`);

  log(`autopg upgrade starting (dryRun=${dryRun}, quiet=${quiet})`);

  const results = [];
  for (const step of STEPS) {
    if (skipSteps.includes(step.name)) {
      log(`[${step.name}] SKIP (excluded by --skip-steps)`);
      results.push({ name: step.name, status: 'SKIP', detail: 'excluded' });
      continue;
    }
    try {
      const stepImpl = require(step.module);
      const result = await runStep(step.name, stepImpl, { dryRun, log, warn });
      results.push(result);
    } catch (err) {
      warn(`[${step.name}] FAIL: ${err.message}`);
      results.push({ name: step.name, status: 'FAIL', detail: err.message });
      // Continue — upgrade is best-effort across steps; user runs `autopg upgrade` again if needed
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const summary = `autopg upgrade complete: ${results.length - failed.length}/${results.length} steps OK`;
  log(summary);
  if (failed.length > 0) {
    warn(`Failed steps: ${failed.map((r) => r.name).join(', ')}`);
    warn('Re-run `autopg upgrade` after addressing the above.');
    return { ok: false, results, summary };
  }
  return { ok: true, results, summary };
}

module.exports = { upgrade, STEPS };
