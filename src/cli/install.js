/**
 * autopg install — binary subcommand (Group 11, autopg-distribution-cutover).
 *
 * Picks up where install.sh hands off. The installer script downloaded +
 * verified the per-platform tarball, extracted it to
 * `~/.autopg/install/<version>/autopg/`, then exec'd
 * `<install-dir>/autopg install --non-interactive`. This module owns the
 * post-extract setup:
 *
 *   1. Write canonical `~/.autopg/config.json` if absent
 *      (channel: stable, port: 8432, installDir, binaryPath, version).
 *   2. Symlink `~/.local/bin/autopg` → `<install-dir>/autopg/autopg`
 *      (atomic via `rename` of a tmp symlink).
 *   3. Append `export PATH="$HOME/.local/bin:$PATH"` to ~/.bashrc + ~/.zshrc
 *      when the line isn't already present (idempotent grep-then-append).
 *   4. Install bash + zsh completions to ~/.local/share/autopg/completions/.
 *   5. Register the daemon under pm2: name=autopg, script=<binary>,
 *      args='serve', cwd=~/.autopg, autorestart=true. Idempotent — second
 *      call sees the existing pm2 entry and short-circuits.
 *   6. First-run hooks (defensive double-fire per D12):
 *        - admin SCRAM bootstrap (Group 1) — fires automatically inside
 *          the daemon process when it starts; we tolerate its absence here
 *          and rely on src/postgres.js wiring.
 *        - upgrade migrations (Group 3) — best-effort once the daemon is
 *          listening; failure logs but does not abort install.
 *
 * `--non-interactive`: never prompt, pick safe defaults, exit 0 only on
 * full success of steps 1–5. Step 6 is best-effort.
 *
 * Test seam: every external side-effect (pm2 spawn, daemon health probe,
 * upgrade-migration runner) is injected via `ctx` so the unit tests in
 * tests/cli/install.test.js can drive the surface without an actual
 * daemon, pm2, or filesystem outside a tempdir.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

export const PM2_PROCESS_NAME = 'autopg';
export const DEFAULT_PORT = 8432;
export const DEFAULT_CHANNEL = 'stable';

// ─── path resolvers ──────────────────────────────────────────────────────

export function getConfigDir(env = process.env) {
  return (
    env.AUTOPG_CONFIG_DIR ||
    env.PGSERVE_CONFIG_DIR ||
    path.join(env.HOME || os.homedir(), '.autopg')
  );
}

export function getConfigPath(env = process.env) {
  return path.join(getConfigDir(env), 'config.json');
}

export function getLocalBinDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), '.local', 'bin');
}

export function getCompletionsDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), '.local', 'share', 'autopg', 'completions');
}

export function getRcFiles(env = process.env) {
  const home = env.HOME || os.homedir();
  return [path.join(home, '.bashrc'), path.join(home, '.zshrc')];
}

// ─── arg parsing ─────────────────────────────────────────────────────────

export function parseArgs(args) {
  const opts = { nonInteractive: false, help: false };
  for (const a of args) {
    if (a === '--non-interactive') opts.nonInteractive = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`autopg install: unknown flag "${a}"`);
  }
  return opts;
}

export const USAGE = `autopg install [--non-interactive]

Pick up after install.sh hands off the verified tarball:
  - register the daemon under pm2 (name: ${PM2_PROCESS_NAME})
  - symlink ~/.local/bin/autopg → <install-dir>/autopg/autopg
  - add ~/.local/bin to PATH in ~/.bashrc and ~/.zshrc
  - install shell completions to ~/.local/share/autopg/completions/
  - write canonical ~/.autopg/config.json
  - run first-run upgrade migrations (best-effort)

Idempotent — re-running picks up where the previous run left off.
`;

// ─── filesystem primitives ───────────────────────────────────────────────

function ensureDir(dir, mode = 0o755) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode });
}

function atomicWriteFile(target, body, mode = 0o644) {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, target);
}

/**
 * Atomic symlink replacement. We `symlinkSync` to a temp name then
 * `renameSync` over the destination — that's the only POSIX path that
 * doesn't briefly leave the target absent. When the destination is a
 * regular file (left over from a manual install), we delete it first.
 */
function atomicSymlink(target, linkPath) {
  ensureDir(path.dirname(linkPath));
  if (fs.lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    const current = fs.readlinkSync(linkPath);
    if (current === target) return { linked: false, reason: 'already-correct' };
  }
  if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
    fs.unlinkSync(linkPath);
  }
  const tmp = `${linkPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, linkPath);
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* swallow */ }
    }
  }
  return { linked: true };
}

/**
 * Idempotent grep-then-append. We never modify a line that already
 * exists; we only append the export line + a single-line marker comment
 * when the marker isn't present. The marker is stable across versions so
 * a re-install detects its own prior write.
 */
const PATH_MARKER = '# autopg: ensure ~/.local/bin on PATH';
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

function ensurePathInRcFile(rcPath) {
  let body = '';
  if (fs.existsSync(rcPath)) {
    body = fs.readFileSync(rcPath, 'utf8');
    if (body.includes(PATH_MARKER) || body.includes(PATH_LINE)) {
      return { changed: false, reason: 'already-present', path: rcPath };
    }
  }
  const trailing = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  const append = `${trailing}\n${PATH_MARKER}\n${PATH_LINE}\n`;
  fs.appendFileSync(rcPath, append, { mode: 0o644 });
  return { changed: true, path: rcPath };
}

// ─── completions ─────────────────────────────────────────────────────────

const BASH_COMPLETION = `# autopg bash completion (Group 11, autopg-distribution-cutover)
_autopg() {
  local cur prev verbs
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  verbs="install uninstall serve daemon status url port upgrade config restart ui create-app list revoke rotate"
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( \$(compgen -W "\${verbs}" -- "\${cur}") )
    return 0
  fi
  return 0
}
complete -F _autopg autopg
complete -F _autopg pgserve
`;

const ZSH_COMPLETION = `#compdef autopg pgserve
# autopg zsh completion (Group 11, autopg-distribution-cutover)
_autopg() {
  local -a verbs
  verbs=(
    'install:Register daemon under pm2'
    'uninstall:Remove daemon from pm2'
    'serve:Start daemon (alias for daemon)'
    'daemon:Start the long-running daemon'
    'status:Print pm2 + config state'
    'url:Print canonical postgres connection string'
    'port:Print canonical port'
    'upgrade:Run idempotent upgrade migrations'
    'config:Manage settings'
    'restart:Restart the daemon'
    'ui:Open the local admin UI'
    'create-app:Provision a per-app role + DB + env file'
    'list:List provisioned apps'
    'revoke:Remove an app'
    'rotate:Rotate an app credential'
  )
  _describe 'autopg verb' verbs
}
_autopg "$@"
`;

function writeCompletions(env = process.env) {
  const dir = getCompletionsDir(env);
  ensureDir(dir);
  const bashPath = path.join(dir, 'autopg.bash');
  const zshPath = path.join(dir, '_autopg');
  atomicWriteFile(bashPath, BASH_COMPLETION, 0o644);
  atomicWriteFile(zshPath, ZSH_COMPLETION, 0o644);
  return { bashPath, zshPath };
}

// ─── canonical config ────────────────────────────────────────────────────

export function writeCanonicalConfig({ binaryPath, version, env = process.env }) {
  const dir = getConfigDir(env);
  ensureDir(dir, 0o755);
  const configPath = getConfigPath(env);
  const installDir = path.dirname(binaryPath);
  const existing = readConfigSafe(configPath);
  if (existing && existing.binaryPath === binaryPath && existing.version === version) {
    return { wrote: false, configPath };
  }
  const merged = {
    channel: existing?.channel ?? DEFAULT_CHANNEL,
    port: existing?.port ?? DEFAULT_PORT,
    dataDir: existing?.dataDir ?? path.join(dir, 'data'),
    binaryPath,
    installDir,
    version: version ?? existing?.version ?? null,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 0o644);
  return { wrote: true, configPath, config: merged };
}

function readConfigSafe(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── pm2 plumbing ────────────────────────────────────────────────────────

function defaultPm2GetProcess(name) {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const list = JSON.parse(out);
    return list.find((p) => p && p.name === name) || null;
  } catch {
    return null;
  }
}

function defaultPm2IsAvailable() {
  try {
    execFileSync('pm2', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function defaultPm2Start({ binaryPath, cwd, port, dataDir, logsDir }) {
  ensureDir(logsDir, 0o755);
  const args = [
    'start',
    binaryPath,
    '--name',
    PM2_PROCESS_NAME,
    '--interpreter',
    'none',
    '--cwd',
    cwd,
    '--max-restarts',
    '50',
    '--restart-delay',
    '4000',
    '--exp-backoff-restart-delay',
    '100',
    '--max-memory-restart',
    '4G',
    '--kill-timeout',
    '60000',
    '--log-date-format',
    'YYYY-MM-DD HH:mm:ss.SSS',
    '--output',
    path.join(logsDir, `${PM2_PROCESS_NAME}-out.log`),
    '--error',
    path.join(logsDir, `${PM2_PROCESS_NAME}-error.log`),
    '--',
    'serve',
    '--port',
    String(port),
    '--data',
    dataDir,
    '--log',
    'warn',
  ];
  const result = spawnSync('pm2', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status ?? 1, stderr: String(result.stderr || '') };
}

// ─── first-run hooks (best-effort) ───────────────────────────────────────

async function defaultRunUpgrade({ log: _log, warn }) {
  try {
    const mod = await import(path.join(process.cwd(), 'src', 'upgrade', 'index.js'));
    const r = await mod.upgrade({ quiet: true });
    return { ran: true, ok: r.ok };
  } catch (e) {
    warn(`autopg install: upgrade migrations skipped (${e.message})`);
    return { ran: false, ok: true, error: e.message };
  }
}

// ─── main entry ──────────────────────────────────────────────────────────

/**
 * @param {string[]} args - argv slice (everything after `install`).
 * @param {object} ctx
 * @param {string} [ctx.binaryPath] - path to the autopg binary; defaults to
 *   `process.execPath` (the bun-compiled binary in real use).
 * @param {string} [ctx.version] - autopg version (BUILD_VERSION); defaults to
 *   `process.env.AUTOPG_VERSION` or null.
 * @param {NodeJS.WriteStream} [ctx.stdout]
 * @param {NodeJS.WriteStream} [ctx.stderr]
 * @param {NodeJS.ProcessEnv} [ctx.env]
 * @param {() => boolean} [ctx.pm2IsAvailable]
 * @param {(name: string) => object|null} [ctx.pm2GetProcess]
 * @param {(opts: object) => {status: number, stderr: string}} [ctx.pm2Start]
 * @param {(opts: object) => Promise<object>} [ctx.runUpgrade]
 */
export async function install(args, ctx = {}) {
  const out = ctx.stdout || process.stdout;
  const err = ctx.stderr || process.stderr;
  const env = ctx.env || process.env;

  let opts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
  if (opts.help) {
    out.write(USAGE);
    return 0;
  }

  const binaryPath = ctx.binaryPath || process.execPath;
  const version = ctx.version ?? env.AUTOPG_VERSION ?? null;

  const pm2IsAvailable = ctx.pm2IsAvailable || defaultPm2IsAvailable;
  const pm2GetProcess = ctx.pm2GetProcess || defaultPm2GetProcess;
  const pm2Start = ctx.pm2Start || defaultPm2Start;
  const runUpgrade = ctx.runUpgrade || defaultRunUpgrade;

  const log = (msg) => out.write(`autopg install: ${msg}\n`);
  const warn = (msg) => err.write(`autopg install: ${msg}\n`);

  // 1. canonical config.json
  const configResult = writeCanonicalConfig({ binaryPath, version, env });
  if (configResult.wrote) {
    log(`wrote ${configResult.configPath}`);
  } else {
    log(`config already canonical at ${configResult.configPath}`);
  }
  const configDir = getConfigDir(env);
  const dataDir = configResult.config?.dataDir ?? path.join(configDir, 'data');
  const port = configResult.config?.port ?? DEFAULT_PORT;
  const logsDir = path.join(configDir, 'logs');

  // 2. ~/.local/bin symlink
  const localBin = getLocalBinDir(env);
  ensureDir(localBin);
  const linkPath = path.join(localBin, 'autopg');
  const linkResult = atomicSymlink(binaryPath, linkPath);
  log(linkResult.linked
    ? `symlinked ${linkPath} → ${binaryPath}`
    : `symlink ${linkPath} already points at ${binaryPath}`);

  // 3. PATH export in rc files
  for (const rc of getRcFiles(env)) {
    const r = ensurePathInRcFile(rc);
    if (r.changed) log(`appended PATH export to ${r.path}`);
    else if (fs.existsSync(rc)) log(`PATH already wired in ${r.path}`);
  }

  // 4. completions
  const comp = writeCompletions(env);
  log(`installed completions: ${comp.bashPath}, ${comp.zshPath}`);

  // 5. pm2 register
  if (!pm2IsAvailable()) {
    warn('pm2 not found in PATH — install with: bun add -g pm2  (skipping daemon registration)');
  } else {
    const existing = pm2GetProcess(PM2_PROCESS_NAME);
    if (existing) {
      log(`pm2 process "${PM2_PROCESS_NAME}" already registered (status=${existing.pm2_env?.status ?? 'unknown'})`);
    } else {
      ensureDir(dataDir, 0o700);
      const result = pm2Start({
        binaryPath,
        cwd: configDir,
        port,
        dataDir,
        logsDir,
      });
      if (result.status !== 0) {
        warn(`pm2 start failed (exit ${result.status}): ${String(result.stderr || '').trim()}`);
        return 1;
      }
      log(`pm2 process "${PM2_PROCESS_NAME}" registered (binary=${binaryPath})`);
    }
  }

  // 6. first-run hooks (best-effort double-fire per D12). The admin SCRAM
  // bootstrap fires inside the daemon process via src/postgres.js wiring;
  // we don't re-fire it here from an out-of-process CLI. Upgrade migrations
  // run idempotently — failure here is non-fatal.
  try {
    const r = await runUpgrade({ log, warn });
    if (r.ran && !r.ok) warn('upgrade migrations reported a failed step (non-fatal — re-run `autopg upgrade`)');
  } catch (e) {
    warn(`upgrade migrations skipped (${e.message})`);
  }

  log('done.');
  return 0;
}

// ─── exports for tests ───────────────────────────────────────────────────

export const _internals = Object.freeze({
  PATH_MARKER,
  PATH_LINE,
  ensurePathInRcFile,
  atomicSymlink,
  writeCompletions,
  readConfigSafe,
});
