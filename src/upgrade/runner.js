/**
 * Step runner — wraps each step with consistent logging + error capture.
 *
 * A step module exports `{ name, plan(ctx), execute(ctx) }`:
 *   - plan(ctx)    → string describing what would happen (dry-run output)
 *   - execute(ctx) → { status: 'OK'|'SKIP'|'FAIL', detail: string }
 */

export async function runStep(name, stepImpl, { dryRun, log, warn }) {
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
