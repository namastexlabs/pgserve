/**
 * `pgserve gc` — sweep orphaned databases. Singleton G3 verb 3.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * The 240-orphan-disease fix from the v1.0 mission. Composes:
 *   - src/gc/orphan-detection.js#classifyOrphans  — pure classifier
 *   - src/gc/audit-log.js#writeGcAudit            — JSON-lines audit
 *   - src/gc/queries.js                           — gc-specific psql queries
 *   - src/lib/admin-json.js                       — port discovery
 *
 * Defaults:
 *   - `--dry-run` is the DEFAULT. gc does NOT drop anything unless
 *     `--apply` is passed. Logs the intent to the audit file with
 *     `dryRun: true` so an operator can audit what *would* have been
 *     swept before flipping the switch.
 *   - `--apply` actually drops. Each drop is audited as `action: drop`.
 *   - `--stale-after-days <N>` overrides the 30d default for the
 *     `idle_stale` orphan signal.
 *   - `--json` emits a single JSON summary at the end (machine-
 *     readable; the per-event audit log is always written regardless).
 *
 * Exit codes:
 *   0   success — partition computed, drops (or dry-run intent)
 *       audited.
 *   1   user error (bad flags, fingerprint missing on a row, etc.)
 *   2   `pgserve_meta` does not exist on the host (no provisions yet);
 *       a clean signal for monitoring rather than a crash.
 *   3   one or more drops failed; the partial sweep is still audited.
 */

import { readAdminJson } from '../lib/admin-json.js';
import { classifyOrphans } from '../gc/orphan-detection.js';
import { writeGcAudit, rotateGcAuditLogs } from '../gc/audit-log.js';
import {
  selectMetaRows,
  selectExistingDbs,
  selectActiveDbs,
  dropDatabase,
  deleteMetaRow,
} from '../gc/queries.js';
import fs from 'node:fs';

const DEFAULT_STALE_AFTER_DAYS = 30;
const USAGE = `Usage: pgserve gc [options]

  --dry-run                show what would be dropped without dropping (default)
  --apply                  actually drop orphan databases + roles + meta rows
  --stale-after-days <N>   override the 30-day idle staleness window
  --json                   emit a JSON summary on stdout
  --port <N>               override the postgres port (default: read admin.json or 5432)

Default mode is dry-run; you must pass --apply to actually drop anything.`;

function parseFlags(argv) {
  const out = {
    apply: false,
    json: false,
    staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
    port: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        out.apply = false;
        break;
      case '--apply':
        out.apply = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--stale-after-days': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) {
          throw new Error('--stale-after-days requires a positive integer');
        }
        out.staleAfterDays = v;
        break;
      }
      case '--port':
      case '-p': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0 || v > 65535) {
          throw new Error('--port requires an integer in [1, 65535]');
        }
        out.port = v;
        break;
      }
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

function resolvePort(opts) {
  if (typeof opts.port === 'number') return opts.port;
  try {
    const admin = readAdminJson();
    if (admin && Number.isInteger(admin.port) && admin.port > 0) return admin.port;
  } catch {
    /* admin.json absent or unreadable — fall through */
  }
  return 5432;
}

function emitJson(summary) {
  process.stdout.write(JSON.stringify(summary) + '\n');
}

function emitHumanSummary(summary) {
  const tag = summary.applied ? 'APPLIED' : 'DRY-RUN';
  process.stdout.write(`pgserve gc [${tag}] — port=${summary.port}, staleAfterDays=${summary.staleAfterDays}\n`);
  process.stdout.write(`  meta rows scanned:    ${summary.scanned}\n`);
  process.stdout.write(`  retained:             ${summary.retained}\n`);
  process.stdout.write(`  orphans found:        ${summary.orphans}\n`);
  if (summary.dropped > 0) {
    process.stdout.write(`  databases dropped:    ${summary.dropped}\n`);
  }
  if (summary.errors.length > 0) {
    process.stdout.write(`  errors:               ${summary.errors.length}\n`);
    for (const e of summary.errors) {
      process.stdout.write(`    - ${e.database}: ${e.message}\n`);
    }
  }
  if (summary.orphans > 0 && !summary.applied) {
    process.stdout.write(`\n  re-run with --apply to actually drop the ${summary.orphans} orphan(s).\n`);
  }
}

export async function runGc(argv = []) {
  let opts;
  try {
    opts = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`pgserve gc: ${err.message}\n\n${USAGE}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const port = resolvePort(opts);
  const summary = {
    applied: opts.apply,
    port,
    staleAfterDays: opts.staleAfterDays,
    scanned: 0,
    retained: 0,
    orphans: 0,
    dropped: 0,
    errors: [],
    findings: [],
  };

  writeGcAudit({
    action: 'start',
    detail: `mode=${opts.apply ? 'apply' : 'dry-run'} port=${port} staleAfterDays=${opts.staleAfterDays}`,
  });

  // Rotate audit logs older than 90 days — runs on every gc invocation
  // (dry-run or apply). Boundary guard preserves the current day's log.
  // Errors are surfaced via the audit log itself; never aborts the gc run.
  try {
    const rotation = rotateGcAuditLogs();
    if (rotation.deleted.length > 0 || rotation.errors.length > 0) {
      writeGcAudit({
        action: 'rotate-summary',
        detail: `deleted=${rotation.deleted.length} kept=${rotation.kept.length} errors=${rotation.errors.length}`,
      });
    }
  } catch (err) {
    writeGcAudit({ action: 'error', reason: 'rotate_failed', detail: err.message });
  }

  let metaRows;
  try {
    metaRows = selectMetaRows({ port });
  } catch (err) {
    if (err.code === 'ENOPGSERVE_META') {
      writeGcAudit({ action: 'finish', reason: 'no_pgserve_meta', detail: err.message });
      if (opts.json) emitJson({ ...summary, error: 'pgserve_meta does not exist' });
      else process.stdout.write(`pgserve gc: pgserve_meta does not exist on this host (no provisions yet)\n`);
      return 2;
    }
    writeGcAudit({ action: 'error', reason: 'select_meta_rows_failed', detail: err.message });
    if (opts.json) emitJson({ ...summary, error: err.message });
    else process.stderr.write(`pgserve gc: ${err.message}\n`);
    return 3;
  }

  let existingDbs;
  let activeDbs;
  try {
    existingDbs = selectExistingDbs({ port });
    activeDbs = selectActiveDbs({ port });
  } catch (err) {
    writeGcAudit({ action: 'error', reason: 'select_pg_state_failed', detail: err.message });
    if (opts.json) emitJson({ ...summary, error: err.message });
    else process.stderr.write(`pgserve gc: ${err.message}\n`);
    return 3;
  }

  const now = new Date();
  const partition = classifyOrphans({
    metaRows,
    existingDbs,
    activeDbs,
    pathExists: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
    now,
    staleAfterMs: opts.staleAfterDays * 24 * 60 * 60 * 1000,
  });
  summary.scanned = metaRows.length;
  summary.retained = partition.retained.length;
  summary.orphans = partition.orphans.length;
  summary.findings = [
    ...partition.orphans.map((f) => ({ ...f, partition: 'orphan' })),
    ...partition.retained.map((f) => ({ ...f, partition: 'retained' })),
  ];

  // Audit every retention decision so an operator can answer "why was
  // X kept?" days later just by reading the JSON-lines log.
  for (const r of partition.retained) {
    writeGcAudit({
      action: 'skip',
      fingerprint: r.row.fingerprint,
      database: r.row.database_name,
      role: r.row.role_name,
      reason: r.reason,
      detail: r.detail,
    });
  }

  for (const o of partition.orphans) {
    if (!opts.apply) {
      writeGcAudit({
        action: 'skip',
        dryRun: true,
        fingerprint: o.row.fingerprint,
        database: o.row.database_name,
        role: o.row.role_name,
        reason: o.reason,
        detail: `would drop (${o.detail})`,
      });
      continue;
    }
    try {
      dropDatabase({ database: o.row.database_name, role: o.row.role_name, port });
      deleteMetaRow({ fingerprint: o.row.fingerprint, port });
      summary.dropped++;
      writeGcAudit({
        action: 'drop',
        fingerprint: o.row.fingerprint,
        database: o.row.database_name,
        role: o.row.role_name,
        reason: o.reason,
        detail: o.detail,
      });
    } catch (err) {
      summary.errors.push({ database: o.row.database_name, message: err.message });
      writeGcAudit({
        action: 'error',
        fingerprint: o.row.fingerprint,
        database: o.row.database_name,
        role: o.row.role_name,
        reason: 'drop_failed',
        detail: err.message,
      });
    }
  }

  writeGcAudit({
    action: 'finish',
    detail: `scanned=${summary.scanned} orphans=${summary.orphans} dropped=${summary.dropped} errors=${summary.errors.length}`,
  });

  if (opts.json) emitJson(summary);
  else emitHumanSummary(summary);

  return summary.errors.length > 0 ? 3 : 0;
}

export const __testInternals = Object.freeze({ parseFlags, resolvePort, emitHumanSummary });
