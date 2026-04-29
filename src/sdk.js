/**
 * Public SDK helpers for applications that want to consume the singleton
 * pgserve daemon without shelling out themselves.
 *
 * The intended flow is:
 *   1. App calls ensureDaemon() during install/startup.
 *   2. App connects with daemonClientOptions().
 *   3. pgserve derives the app identity from the Unix-socket peer creds and
 *      routes it to that app's fingerprinted database.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isProcessAlive,
  resolveControlSocketDir,
  resolveControlSocketPath,
  resolveLibpqCompatPath,
  resolvePidLockPath,
} from './daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function probeDaemon({ controlSocketDir = resolveControlSocketDir() } = {}) {
  const socketPath = resolveControlSocketPath(controlSocketDir);
  const libpqSocketPath = resolveLibpqCompatPath(controlSocketDir);
  const pidLockPath = resolvePidLockPath(controlSocketDir);
  const socketPresent = fs.existsSync(socketPath);
  const libpqSocketPresent = fs.existsSync(libpqSocketPath);
  let pid = null;

  try {
    const raw = fs.readFileSync(pidLockPath, 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // Missing/unreadable pid file means no live daemon can be trusted.
  }

  const pidAlive = pid !== null && isProcessAlive(pid);
  const running = pidAlive && socketPresent && libpqSocketPresent;
  return {
    running,
    pid: pidAlive ? pid : null,
    socketPresent,
    libpqSocketPresent,
    controlSocketDir,
    controlSocketPath: socketPath,
    libpqSocketPath,
    pidLockPath,
    reason: running ? null : explainProbeMiss({ pid, pidAlive, socketPresent, libpqSocketPresent }),
  };
}

function explainProbeMiss({ pid, pidAlive, socketPresent, libpqSocketPresent }) {
  if (pid === null && !socketPresent && !libpqSocketPresent) return 'no daemon';
  if (pid !== null && !pidAlive) return 'stale pid';
  if (!socketPresent) return 'control socket missing';
  if (!libpqSocketPresent) return 'libpq socket missing';
  return 'not running';
}

export function daemonClientOptions({
  controlSocketDir = resolveControlSocketDir(),
  database = 'postgres',
  username = 'postgres',
} = {}) {
  return {
    host: controlSocketDir,
    port: 5432,
    database,
    username,
    password: '',
  };
}

export function buildDaemonArgs({
  dataDir,
  ram = false,
  logLevel,
  noProvision = false,
  listens = [],
  pgvector = false,
} = {}) {
  const args = ['daemon'];
  if (dataDir) args.push('--data', dataDir);
  if (ram) args.push('--ram');
  if (logLevel) args.push('--log', logLevel);
  if (noProvision) args.push('--no-provision');
  if (pgvector) args.push('--pgvector');
  for (const listen of Array.isArray(listens) ? listens : [listens]) {
    if (listen) args.push('--listen', String(listen));
  }
  return args;
}

export async function ensureDaemon(options = {}) {
  const controlSocketDir = options.controlSocketDir || resolveControlSocketDir();
  const initial = probeDaemon({ controlSocketDir });
  if (initial.running) return initial;

  const bin = options.bin || resolveBundledCliBin();
  const env = { ...process.env, ...envForControlSocketDir(controlSocketDir), ...(options.env || {}) };
  const child = spawn(bin, buildDaemonArgs(options), {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();

  const timeoutMs = options.timeoutMs || 16000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = probeDaemon({ controlSocketDir });
    if (state.running) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const state = probeDaemon({ controlSocketDir });
  const err = new Error(`pgserve daemon did not become ready within ${timeoutMs}ms (${state.reason})`);
  err.code = 'EPGSERVE_DAEMON_TIMEOUT';
  err.state = state;
  throw err;
}

export function resolveBundledCliBin() {
  return path.join(__dirname, '..', 'bin', 'pgserve-wrapper.cjs');
}

function envForControlSocketDir(controlSocketDir) {
  if (path.basename(controlSocketDir) !== 'pgserve') {
    throw new Error('ensureDaemon: controlSocketDir must be a pgserve runtime directory ending in /pgserve');
  }
  return { XDG_RUNTIME_DIR: path.dirname(controlSocketDir) };
}
