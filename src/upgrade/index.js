/**
 * autopg upgrade — idempotent migration orchestrator.
 *
 * Runs steps in order, each safe to re-run any number of times:
 *   1. port-reconcile         — ensure pgserve listens on canonical port (8432)
 *   2. binary-cache-flush     — verify binary version matches PINNED_PG_VERSION
 *   3. rename-meta            — relocate pgserve_meta into autopg_meta schema
 *   4. autopg-apps-ddl        — create autopg_meta.autopg_apps table
 *   5. pgserve-symlink-compat — `~/.pgserve` symlink → `~/.autopg`
 *   6. plpgsql-resolve        — DROP+CREATE plpgsql per DB to refresh .so path
 *   7. env-refresh            — regenerate ~/.autopg/<app>.env URLs
 *   8. consumer-signal        — touch ~/.autopg/state/upgrade.signal
 *   9. health-validate        — pg_isready + per-DB plpgsql smoke test
 *
 * Patches the upgrade-path hole left by autopg-v22 partial roll-out.
 * Steps 3–5 land in autopg-distribution-cutover (Group 3, this wish).
 * See: .genie/wishes/autopg-upgrade-command/WISH.md and
 *      .genie/wishes/autopg-distribution-cutover/WISH.md
 */

import { runStep } from './runner.js';
import * as portReconcile from './steps/port-reconcile.js';
import * as binaryCacheFlush from './steps/binary-cache-flush.js';
import * as renameMeta from './steps/100-rename-meta.js';
import * as autopgAppsDdl from './steps/101-autopg-apps-ddl.js';
import * as pgserveSymlinkCompat from './steps/102-pgserve-symlink-compat.js';
import * as plpgsqlResolve from './steps/plpgsql-resolve.js';
import * as envRefresh from './steps/env-refresh.js';
import * as consumerSignal from './steps/consumer-signal.js';
import * as healthValidate from './steps/health-validate.js';

export const STEPS = [
  { name: 'port-reconcile', impl: portReconcile },
  { name: 'binary-cache-flush', impl: binaryCacheFlush },
  { name: 'rename-meta', impl: renameMeta },
  { name: 'autopg-apps-ddl', impl: autopgAppsDdl },
  { name: 'pgserve-symlink-compat', impl: pgserveSymlinkCompat },
  { name: 'plpgsql-resolve', impl: plpgsqlResolve },
  { name: 'env-refresh', impl: envRefresh },
  { name: 'consumer-signal', impl: consumerSignal },
  { name: 'health-validate', impl: healthValidate },
];

export async function upgrade(options = {}) {
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
      const result = await runStep(step.name, step.impl, { dryRun, log, warn });
      results.push(result);
    } catch (err) {
      warn(`[${step.name}] FAIL: ${err.message}`);
      results.push({ name: step.name, status: 'FAIL', detail: err.message });
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
