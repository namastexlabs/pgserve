/**
 * Step runner — wraps each step with consistent logging + error capture.
 *
 * A step module exports `{ name, plan(ctx), execute(ctx) }`:
 *   - plan(ctx)    → returns a string describing what would happen (dry-run output)
 *   - execute(ctx) → returns { status: 'OK'|'SKIP'|'FAIL', detail: string }
 *
 * The runner ensures both modes (dry-run + execute) emit a consistent
 * `[name] STATUS: detail` line so logs are grep-friendly.
 */

async function runStep(name, stepImpl, { dryRun, log, warn }) {
  if (typeof stepImpl.plan !== 'function' || typeof stepImpl.execute !== 'function') {
    throw new Error(`step ${name} missing plan() or execute()`);
  }
  if (dryRun) {
    const planned = await stepImpl.plan({ log, warn });
    log(`[${name}] DRY-RUN: ${planned}`);
    return { name, status: 'DRY-RUN', detail: planned };
  }
  const result = await stepImpl.execute({ log, warn });
  const status = result.status || 'OK';
  const detail = result.detail || '';
  log(`[${name}] ${status}: ${detail}`);
  return { name, status, detail };
}

module.exports = { runStep };
