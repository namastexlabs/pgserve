/**
 * `pgserve doctor` — health-check the local pgserve install.
 *
 * pgserve-singleton-no-proxy wish, Group 3 (read-only V1; --fix tiered
 * modes deferred to a follow-up — see SHARED-DESIGN.md §3.2).
 *
 * Goals:
 *   - Read-only by default. Surfaces every detectable misconfiguration as a
 *     structured finding so an operator (or `pgserve doctor --json` output
 *     piped to a tool) can act on it without `pgserve doctor` itself
 *     mutating the host.
 *   - Honors the cohort supervisor model: reads `~/.autopg/admin.json`
 *     (singleton G1 + canonical G1 + cutover G11 co-owned schema) and
 *     dispatches the matching liveness probe (pm2 / systemd-user / launchd).
 *   - Reports `<socketDir>/runtime.json` (cutover G19 live-discovery file)
 *     and the postmaster reachability on both the canonical Unix socket and
 *     TCP loopback.
 *   - Refuses to suggest tier swaps. Felipe directive 2026-05-08: doctor
 *     reports passively.
 *
 * Out of scope (V1):
 *   - `--fix` / `--fix --aggressive` mutations. Tiered mode design (Cat 1/2/3)
 *     locked in SHARED-DESIGN §3.2 but implementation lives in a follow-up.
 *   - GC sweep (G3 sibling verb).
 *   - Cosign verify state inspection beyond what's already in `pgserve_meta`.
 *
 * Output modes:
 *   - default: human-readable summary, exit 0 if every check passes, exit 1
 *     if any FAIL, exit 2 if any WARN (no FAILs).
 *   - `--json`: emits `{ ok, findings: [...], summary }` to stdout. Exit
 *     code identical to the human path.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
import { getAdminFilePath, readAdminJson } from '../lib/admin-json.js';
import { resolveSocketDir } from '../lib/socket-dir.js';
import { readRuntimeJson, isLiveRuntime } from '../lib/runtime-json.js';
import { findBlocked } from '../security/blocked-versions.js';

const SEVERITY = Object.freeze({ PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' });

/**
 * @typedef {Object} Finding
 * @property {string}    id        Stable check id (snake_case, grep-friendly).
 * @property {string}    title     Human-readable summary.
 * @property {'PASS'|'WARN'|'FAIL'} severity
 * @property {string}    [detail]  One-line operator-facing explanation.
 * @property {string}    [hint]    Optional remediation hint.
 */

function check(id, title, severity, detail, hint) {
  /** @type {Finding} */
  const f = { id, title, severity };
  if (detail) f.detail = detail;
  if (hint) f.hint = hint;
  return f;
}

function getCurrentVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return undefined;
  }
}

// ─── individual checks ────────────────────────────────────────────────

function checkVersionNotBlocked() {
  const version = getCurrentVersion();
  if (!version) {
    return check(
      'version_blocklist',
      'pgserve binary version not blocked',
      SEVERITY.WARN,
      'cannot read pgserve version from package.json',
      'reinstall pgserve via npm/bun and re-run',
    );
  }
  const hit = findBlocked(version);
  if (hit) {
    return check(
      'version_blocklist',
      `pgserve@${version} is on the hardcoded blocklist`,
      SEVERITY.FAIL,
      hit.reason,
      'install a different version (run `pgserve update` for the latest)',
    );
  }
  return check('version_blocklist', `pgserve@${version} is not blocked`, SEVERITY.PASS);
}

function checkAdminJsonExists() {
  const file = getAdminFilePath();
  if (!fs.existsSync(file)) {
    return check(
      'admin_json_exists',
      '~/.autopg/admin.json missing',
      SEVERITY.FAIL,
      `${file} does not exist — pgserve install has not run`,
      'run `pgserve install` (Tier A) or `autopg service install` (Tier B)',
    );
  }
  try {
    const stat = fs.statSync(file);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      return check(
        'admin_json_exists',
        '~/.autopg/admin.json file mode is not 0600',
        SEVERITY.WARN,
        `mode is 0${mode.toString(8)} — should be 0600 (cohort schema)`,
        'chmod 600 ~/.autopg/admin.json',
      );
    }
  } catch (e) {
    return check('admin_json_exists', '~/.autopg/admin.json stat failed', SEVERITY.FAIL, e.message);
  }
  return check('admin_json_exists', '~/.autopg/admin.json exists with mode 0600', SEVERITY.PASS);
}

function checkAdminJsonShape() {
  let admin;
  try {
    admin = readAdminJson();
  } catch {
    return check(
      'admin_json_shape',
      '~/.autopg/admin.json could not be parsed',
      SEVERITY.FAIL,
      'JSON parse failed',
      'restore from backup or run `pgserve install` to regenerate',
    );
  }
  if (!admin) {
    return check(
      'admin_json_shape',
      '~/.autopg/admin.json missing or empty',
      SEVERITY.WARN,
      'readAdminJson returned null — file may not exist yet',
    );
  }
  const supervisor = admin.supervisor;
  const validSupervisor = ['pm2', 'systemd-user', 'launchd', 'external'].includes(supervisor);
  if (!validSupervisor) {
    return check(
      'admin_json_shape',
      `admin.json.supervisor is invalid: ${JSON.stringify(supervisor)}`,
      SEVERITY.FAIL,
      'expected one of {pm2, systemd-user, launchd, external}',
      'reinstall via `pgserve install` (Tier A) or `autopg service install` (Tier B)',
    );
  }
  return check(
    'admin_json_shape',
    `admin.json.supervisor = "${supervisor}"`,
    SEVERITY.PASS,
    `port=${admin.port ?? '?'}, socketDir=${admin.socketDir ?? '?'}`,
  );
}

function pm2EntryOnline(name) {
  try {
    const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) return { ok: false, reason: 'pm2 jlist failed' };
    const list = JSON.parse(result.stdout || '[]');
    const entry = list.find((p) => p.name === name);
    if (!entry) return { ok: false, reason: 'no pm2 entry found' };
    if (entry.pm2_env?.status !== 'online') {
      return { ok: false, reason: `pm2 entry status: ${entry.pm2_env?.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function systemdUnitActive(unit, scope) {
  const args = scope === 'user' ? ['--user', 'is-active', unit] : ['is-active', unit];
  try {
    const result = spawnSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: result.status === 0, reason: (result.stdout || '').trim() || 'unknown' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function launchdJobLoaded(label) {
  try {
    const result = spawnSync('launchctl', ['list', label], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: result.status === 0, reason: result.status === 0 ? 'loaded' : 'not loaded' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function checkSupervisorLiveness(admin) {
  if (!admin || !admin.supervisor) {
    return check(
      'supervisor_liveness',
      'cannot probe supervisor — admin.json absent or invalid',
      SEVERITY.WARN,
    );
  }
  switch (admin.supervisor) {
    case 'pm2': {
      const r = pm2EntryOnline('autopg-server');
      return r.ok
        ? check('supervisor_liveness', 'pm2 autopg-server entry online', SEVERITY.PASS)
        : check('supervisor_liveness', 'pm2 autopg-server entry not online', SEVERITY.FAIL, r.reason, 'run `pgserve install` to (re-)register pm2 entry');
    }
    case 'systemd-user': {
      const r = systemdUnitActive('autopg.service', 'user');
      return r.ok
        ? check('supervisor_liveness', 'systemd-user autopg.service active', SEVERITY.PASS, r.reason)
        : check('supervisor_liveness', `systemd-user autopg.service not active`, SEVERITY.FAIL, r.reason, 'run `systemctl --user status autopg.service` for details');
    }
    case 'launchd': {
      const r = launchdJobLoaded('dev.automagik.autopg');
      return r.ok
        ? check('supervisor_liveness', 'launchd dev.automagik.autopg loaded', SEVERITY.PASS)
        : check('supervisor_liveness', 'launchd dev.automagik.autopg not loaded', SEVERITY.FAIL, r.reason, 'run `autopg service install` to (re-)register');
    }
    case 'external':
      return check(
        'supervisor_liveness',
        'supervisor=external — operator owns supervision; no automated liveness check',
        SEVERITY.PASS,
      );
    default:
      return check('supervisor_liveness', `unknown supervisor: ${admin.supervisor}`, SEVERITY.FAIL);
  }
}

function checkRuntimeJson(admin) {
  const socketDir = admin?.socketDir || resolveSocketDir();
  let runtime;
  try {
    runtime = readRuntimeJson(socketDir);
  } catch {
    runtime = null;
  }
  if (!runtime) {
    return check(
      'runtime_json',
      `<socketDir>/runtime.json missing or unreadable`,
      SEVERITY.WARN,
      `looked at ${socketDir}/runtime.json — postmaster may not be running, or runtime file was cleaned on graceful shutdown`,
    );
  }
  if ('supervisor' in runtime) {
    return check(
      'runtime_json',
      'runtime.json has a `supervisor` field — cohort contract violated',
      SEVERITY.FAIL,
      'runtime.json (live discovery) MUST NOT carry supervisor — that lives in admin.json only',
      'remove the supervisor field; cutover G19 spec',
    );
  }
  const live = isLiveRuntime(runtime);
  if (!live) {
    return check(
      'runtime_json',
      `runtime.json points at non-live autopgPid=${runtime.autopgPid}`,
      SEVERITY.WARN,
      'process is no longer running; the file should have been cleaned on graceful shutdown',
      'restart the postmaster to refresh runtime.json',
    );
  }
  return check(
    'runtime_json',
    `runtime.json present + autopgPid=${runtime.autopgPid} alive`,
    SEVERITY.PASS,
    `port=${runtime.port}, schemaVersion=${runtime.schemaVersion}`,
  );
}

function checkUdsReachable(admin) {
  const socketDir = admin?.socketDir || resolveSocketDir();
  const port = admin?.port || 5432;
  const sockPath = path.join(socketDir, `.s.PGSQL.${port}`);
  if (!fs.existsSync(sockPath)) {
    return check(
      'uds_reachable',
      `Unix socket missing at ${sockPath}`,
      SEVERITY.FAIL,
      'postmaster has not bound the canonical socket',
      'check postmaster logs / supervisor liveness',
    );
  }
  // Probe by connecting; postgres responds even before SSL handshake on a healthy socket.
  try {
    const sock = new net.Socket();
    let connected = false;
    sock.on('connect', () => { connected = true; sock.destroy(); });
    sock.connect(sockPath);
    // Synchronous-ish wait via deasync-free pattern: small timeout, deterministic result.
    const start = Date.now();
    while (!connected && Date.now() - start < 500) {
      execSync('true'); // yield event loop without sleep
    }
    if (!connected) {
      return check('uds_reachable', `Unix socket not accepting at ${sockPath}`, SEVERITY.FAIL);
    }
    return check('uds_reachable', `Unix socket accepting at ${sockPath}`, SEVERITY.PASS);
  } catch (e) {
    return check('uds_reachable', `Unix socket probe failed`, SEVERITY.FAIL, e.message);
  }
}

function checkTcpReachable(admin) {
  const port = admin?.port || 5432;
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let resolved = false;
    const done = (severity, detail) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(check('tcp_reachable', `TCP localhost:${port}`, severity, detail));
    };
    sock.setTimeout(500);
    sock.on('connect', () => done(SEVERITY.PASS, 'connected'));
    sock.on('timeout', () => done(SEVERITY.WARN, 'timed out (postmaster may not be on this port)'));
    sock.on('error', (e) => done(SEVERITY.WARN, e.code || e.message));
    sock.connect(port, '127.0.0.1');
  });
}

// ─── orchestration ────────────────────────────────────────────────────

/**
 * Run all checks and return findings.
 * @returns {Promise<Finding[]>}
 */
export async function runChecks() {
  const findings = [];
  findings.push(checkVersionNotBlocked());
  findings.push(checkAdminJsonExists());
  findings.push(checkAdminJsonShape());

  let admin = null;
  try { admin = readAdminJson(); } catch { /* admin_json_shape already reported */ }

  findings.push(checkSupervisorLiveness(admin));
  findings.push(checkRuntimeJson(admin));
  findings.push(checkUdsReachable(admin));
  findings.push(await checkTcpReachable(admin));

  return findings;
}

/**
 * Compute the exit code from a list of findings.
 * @param {Finding[]} findings
 */
export function exitCodeFor(findings) {
  if (findings.some((f) => f.severity === SEVERITY.FAIL)) return 1;
  if (findings.some((f) => f.severity === SEVERITY.WARN)) return 2;
  return 0;
}

function summary(findings) {
  const pass = findings.filter((f) => f.severity === SEVERITY.PASS).length;
  const warn = findings.filter((f) => f.severity === SEVERITY.WARN).length;
  const fail = findings.filter((f) => f.severity === SEVERITY.FAIL).length;
  return { total: findings.length, pass, warn, fail };
}

function emitHuman(findings, options = {}) {
  const stream = options.stream || process.stdout;
  for (const f of findings) {
    const tag = f.severity === SEVERITY.PASS ? '✓' : f.severity === SEVERITY.WARN ? '⚠' : '✗';
    stream.write(`${tag} [${f.severity}] ${f.id}: ${f.title}\n`);
    if (f.detail) stream.write(`    ${f.detail}\n`);
    if (f.hint && f.severity !== SEVERITY.PASS) stream.write(`    hint: ${f.hint}\n`);
  }
  const s = summary(findings);
  stream.write(`\n${s.pass} pass, ${s.warn} warn, ${s.fail} fail (${s.total} checks)\n`);
}

function emitJson(findings, options = {}) {
  const stream = options.stream || process.stdout;
  const ok = findings.every((f) => f.severity === SEVERITY.PASS);
  stream.write(`${JSON.stringify({ ok, summary: summary(findings), findings }, null, 2)}\n`);
}

/**
 * Entry point for `pgserve doctor`.
 * @param {string[]} argv
 */
export async function runDoctor(argv = []) {
  if (argv.includes('--fix')) {
    process.stderr.write(
      'pgserve doctor: --fix tiered modes are not implemented in v2.4 — read-only V1.\n' +
      '  See SHARED-DESIGN.md §3.2 for the planned Cat 1/2/3 contract; tracked as a follow-up.\n',
    );
    return 64;
  }

  const findings = await runChecks();
  const json = argv.includes('--json');
  if (json) emitJson(findings);
  else emitHuman(findings);
  return exitCodeFor(findings);
}

// Test-only re-exports — referenced by tests/cli/doctor.test.js so the
// individual check functions can be exercised in isolation.
export const __testInternals = Object.freeze({
  checkVersionNotBlocked,
  checkAdminJsonExists,
  checkAdminJsonShape,
  checkRuntimeJson,
  checkSupervisorLiveness,
  exitCodeFor,
  SEVERITY,
});
