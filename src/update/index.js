/**
 * pgserve update — idempotent in-place migration orchestrator.
 *
 * v3.0.0 verb rename: this module is `src/update/` (was `src/upgrade/`).
 * The CLI dispatch case in `src/cli-install.cjs` is `update`; the
 * `pgserve upgrade` verb is gone (clean cutover, no alias).
 *
 * Runs 6 steps in order, each safe to re-run any number of times:
 *   1. port-reconcile    — ensure pgserve listens on canonical port (8432)
 *   2. binary-cache-flush — verify binary version matches PINNED_PG_VERSION
 *   3. plpgsql-resolve   — DROP+CREATE plpgsql per DB to refresh .so path
 *   4. env-refresh       — regenerate ~/.autopg/<app>.env URLs
 *   5. consumer-signal   — touch ~/.autopg/state/upgrade.signal
 *   6. health-validate   — pg_isready + per-DB plpgsql smoke test
 *
 * Patches the upgrade-path hole left by autopg-v22 partial roll-out.
 * See: .genie/wishes/autopg-upgrade-command/WISH.md
 */

import { runStep } from './runner.js';
import * as portReconcile from './steps/port-reconcile.js';
import * as binaryCacheFlush from './steps/binary-cache-flush.js';
import * as plpgsqlResolve from './steps/plpgsql-resolve.js';
import * as envRefresh from './steps/env-refresh.js';
import * as consumerSignal from './steps/consumer-signal.js';
import * as healthValidate from './steps/health-validate.js';
import * as cosignMetaMigration from './steps/cosign-meta-migration.js';

export const STEPS = [
  { name: 'port-reconcile', impl: portReconcile },
  { name: 'binary-cache-flush', impl: binaryCacheFlush },
  { name: 'plpgsql-resolve', impl: plpgsqlResolve },
  // pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
  // Adds the additive `verified_*` columns to `pgserve_meta`. Runs after
  // plpgsql-resolve so the extension is available; idempotent per-DB.
  { name: 'cosign-meta-migration', impl: cosignMetaMigration },
  { name: 'env-refresh', impl: envRefresh },
  { name: 'consumer-signal', impl: consumerSignal },
  { name: 'health-validate', impl: healthValidate },
];

export async function update(options = {}) {
  const { quiet = false, dryRun = false, skipSteps = [] } = options;
  const log = (msg) => { if (!quiet) process.stderr.write(`${msg}\n`); };
  const warn = (msg) => process.stderr.write(`${msg}\n`);

  log(`pgserve update starting (dryRun=${dryRun}, quiet=${quiet})`);

  const results = [];
  for (const step of STEPS) {
    if (skipSteps.includes(step.name)) {
      log(`[${step.name}] SKIP (excluded by --skip-steps)`);
      results.push({ name: step.name, status: 'SKIP', detail: 'excluded' });
      continue;
    }
    try {
      const result = await runStep(step.name, step.impl, { dryRun, log, warn });
      results.push(result);
    } catch (err) {
      warn(`[${step.name}] FAIL: ${err.message}`);
      results.push({ name: step.name, status: 'FAIL', detail: err.message });
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const summary = `pgserve update complete: ${results.length - failed.length}/${results.length} steps OK`;
  log(summary);
  if (failed.length > 0) {
    warn(`Failed steps: ${failed.map((r) => r.name).join(', ')}`);
    warn('Re-run `pgserve update` after addressing the above.');
    return { ok: false, results, summary };
  }
  return { ok: true, results, summary };
}
