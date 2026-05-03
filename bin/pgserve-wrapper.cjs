#!/usr/bin/env node
/**
 * pgserve wrapper - Finds and spawns bun runtime from node_modules
 *
 * This wrapper enables `npx pgserve` to work without requiring
 * users to install bun globally. The bun runtime is bundled as
 * an npm dependency and this wrapper finds and invokes it.
 *
 * Windows EBUSY fix: Uses synchronous waiting and taskkill for
 * reliable process termination and file handle cleanup.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ────────────────────────────────────────────────────────────────────────
// canonical-pgserve-pm2-supervision wish (PR #55, issue #56)
//
// `pgserve install / uninstall / status / url / port` are pure node + pm2
// wrappers — they don't need bun at all. Route them BEFORE the bun
// resolution + health probe so install works on a machine where bun
// hasn't self-healed yet (the chicken-and-egg case the probe was designed
// to detect — operators should be able to set up a fresh server even when
// the bun-postinstall failed).
//
// `pgserve serve` is an alias for the existing `pgserve daemon` (the
// long-lived process pm2 invokes); we rewrite argv so postgres-server.js
// sees the original `daemon` token.
// ────────────────────────────────────────────────────────────────────────
const __subcommand = process.argv[2];
const __installSubcommands = new Set([
  'install',
  'uninstall',
  'status',
  'url',
  'port',
  // autopg-console-settings (Group 2): config / restart / ui are pure node
  // wrappers that read/write `~/.autopg/settings.json` (and shell out to
  // pm2 for restart). They don't need bun, so route them BEFORE the bun
  // probe — same rationale as the wave-1 install commands.
  'config',
  'upgrade',
  'restart',
  'ui',
]);
if (__subcommand && __installSubcommands.has(__subcommand)) {
  const cli = require(path.join(__dirname, '..', 'src', 'cli-install.cjs'));
  const result = cli.dispatch(__subcommand, process.argv.slice(3), {
    scriptPath: path.join(__dirname, 'postgres-server.js'),
    wrapperPath: __filename,
  });
  // `ui` returns a Promise that never resolves (the server parks on
  // signals). Other subcommands return a number directly. Handle both.
  if (result && typeof result.then === 'function') {
    result.then(
      (code) => process.exit(typeof code === 'number' ? code : 0),
      (err) => {
        process.stderr.write(`pgserve: ${err?.message ?? err}\n`);
        process.exit(1);
      },
    );
    return;
  }
  process.exit(typeof result === 'number' ? result : 0);
}
if (__subcommand === 'serve') {
  // Alias `serve` → `daemon` so the wish's canonical command name maps
  // cleanly to the existing long-lived process. Replacing argv preserves
  // any flags the operator (or pm2) passed after `serve`.
  process.argv[2] = 'daemon';
}

// Detect platform
const isWindows = process.platform === 'win32';
const bunBin = isWindows ? 'bun.exe' : 'bun';

// Try multiple locations for cross-platform compatibility
// Order matters - most common locations first
// Note: npm hoists dependencies, so bun may be in parent node_modules
const locations = [
  // Hoisted to top-level node_modules (npm default behavior)
  path.join(__dirname, '..', '..', '.bin', bunBin),
  // Standard location when not hoisted
  path.join(__dirname, '..', 'node_modules', '.bin', bunBin),
  // Direct bun package location (some npm versions)
  path.join(__dirname, '..', 'node_modules', 'bun', bunBin),
  // Hoisted bun package
  path.join(__dirname, '..', '..', 'bun', bunBin),
  // Platform-specific @oven packages (hoisted)
  path.join(__dirname, '..', '..', '@oven', `bun-${process.platform}-${process.arch}`, bunBin),
  // Platform-specific @oven packages (not hoisted)
  path.join(__dirname, '..', 'node_modules', '@oven', `bun-${process.platform}-${process.arch}`, bunBin),
  // Alternative arch naming (darwin-aarch64 vs darwin-arm64)
  path.join(__dirname, '..', '..', '@oven', `bun-${process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch}`, bunBin),
  // Windows specific paths
  isWindows ? path.join(__dirname, '..', '..', '.bin', 'bun.cmd') : null,
  isWindows ? path.join(__dirname, '..', 'node_modules', '.bin', 'bun.cmd') : null,
].filter(Boolean);

const bunPath = locations.find(p => fs.existsSync(p));

if (!bunPath) {
  console.error('Error: Could not find bun runtime.');
  console.error('');
  console.error('Tried locations:');
  locations.forEach(l => console.error(`  - ${l}`));
  console.error('');
  console.error('Try reinstalling: npm install pgserve');
  process.exit(1);
}

const scriptPath = path.join(__dirname, 'postgres-server.js');

// Pre-flight health check: verify bun can actually execute.
//
// When pgserve is installed via `bun install` (as a global or transitive dep),
// the nested `bun` npm package's postinstall can be skipped, leaving
// `@oven/bun-<platform>/bin/bun` empty. The bun stub at `node_modules/bun/bin/bun`
// then exits instantly with:
//   Error: Bun's postinstall script was not run.
//
// postgres-server.js's TCP readiness poll can't distinguish this from a slow
// startup, so users see a confusing 30s timeout. Detect the specific error
// here, attempt the documented self-heal once (`node install.js`), and retry.
// If self-heal also fails, surface the real error instead of hanging later.
ensureBunHealthy(bunPath);

/**
 * Verify the selected bun binary can execute. If it fails with the known
 * "postinstall script was not run" signature, attempt a one-shot repair via
 * the bun npm package's install.js. Throws (with a useful message) rather
 * than letting postgres-server.js hang on the TCP readiness poll for 30s.
 */
function ensureBunHealthy(bunExe) {
  const probe = probeBun(bunExe);
  if (probe.ok) return;

  // Only attempt self-heal for the specific postinstall-not-run failure.
  // Any other failure (corrupt binary, unsupported glibc, etc.) is surfaced
  // as-is rather than silently papered over.
  if (!isPostinstallMissingError(probe.output)) {
    console.error('Error: bun runtime at', bunExe, 'failed to execute:');
    console.error(probe.output || '(no output)');
    process.exit(1);
  }

  const installJs = findBunInstallJs(bunExe);
  if (!installJs) {
    console.error('Error: bun runtime at', bunExe, 'is missing its platform binary,');
    console.error('and the recovery script (node_modules/bun/install.js) could not be located.');
    console.error('');
    console.error('Try reinstalling pgserve, or run the fix manually:');
    console.error('  cd <node_modules>/bun && node install.js');
    process.exit(1);
  }

  console.error('[pgserve] bun runtime missing platform binary; attempting self-heal...');
  try {
    execSync(`node ${JSON.stringify(installJs)}`, { stdio: 'inherit' });
  } catch {
    // fall through to second probe
  }

  const second = probeBun(bunExe);
  if (second.ok) {
    console.error('[pgserve] bun runtime recovered.');
    return;
  }

  console.error('Error: bun runtime still broken after self-heal attempt.');
  console.error(second.output || '(no output)');
  console.error('');
  console.error('Manual fix:');
  console.error(`  cd ${path.dirname(path.dirname(installJs))}/bun && node install.js`);
  console.error('');
  console.error('Upstream bug: https://github.com/namastexlabs/pgserve/issues/22');
  process.exit(1);
}

function probeBun(bunExe) {
  try {
    const out = execSync(`${JSON.stringify(bunExe)} --version`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      encoding: 'utf8'
    });
    return { ok: true, output: out };
  } catch (err) {
    const output = [err.stderr, err.stdout, err.message]
      .filter(Boolean).map(String).join('\n');
    return { ok: false, output };
  }
}

function isPostinstallMissingError(output) {
  return typeof output === 'string' &&
    /Bun's postinstall script was not run/i.test(output);
}

function findBunInstallJs(bunExe) {
  // Walk up from the bun binary toward a `bun` package dir containing install.js.
  // Matches the wrapper's own location list - bun is always nested under a
  // `bun` package directory (or its `bin/` subdir).
  let cursor = path.dirname(path.resolve(bunExe));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cursor, 'install.js');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(cursor, 'package.json'))) {
      return candidate;
    }
    const nested = path.join(cursor, 'bun', 'install.js');
    if (fs.existsSync(nested)) return nested;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

// Platform-specific spawning strategy:
// - Windows: Use pipes for explicit handle control (prevents EBUSY errors)
// - Unix: Use inherit for simplicity (works fine)

if (isWindows) {
  // WINDOWS PATH: Explicit pipe control to prevent EBUSY errors
  // Using stdio: 'inherit' causes file handle inheritance that we cannot release,
  // leading to npm cleanup failures. With pipes, we control when handles are destroyed.

  const child = spawn(bunPath, [scriptPath, ...process.argv.slice(2)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  // Manually pipe stdio - we now control the handles
  // Handle stdin errors gracefully (may not be connected in some environments)
  process.stdin.on('error', () => {});
  child.stdin.on('error', () => {});

  // Only pipe stdin if it's readable
  if (process.stdin.readable) {
    process.stdin.pipe(child.stdin);
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on('error', (err) => {
    console.error('Failed to start pgserve:', err.message);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    // CRITICAL: Explicitly destroy ALL streams to release file handles
    // This must happen BEFORE process.exit() to prevent EBUSY
    try {
      if (process.stdin.readable) {
        process.stdin.unpipe(child.stdin);
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    } catch {
      // Ignore stream destruction errors
    }

    // Remove all listeners to prevent memory leaks
    child.removeAllListeners();

    // Use setImmediate to ensure stream destruction completes before exit
    // This gives the event loop one tick to process pending I/O cleanup
    setImmediate(() => {
      process.exit(signal ? 1 : (code ?? 0));
    });
  });

  // Windows: use taskkill for reliable process termination
  // process.kill(pid, 'SIGINT') does NOT work properly on Windows
  process.on('SIGINT', () => {
    if (child.pid) {
      try {
        // /T = terminate child processes (tree), /F = force
        execSync(`taskkill /PID ${child.pid} /T /F`, {
          stdio: 'ignore',
          windowsHide: true
        });
      } catch {
        // Process may have already exited, ignore errors
      }
    }
  });

  // Handle Ctrl+C via readline for Windows terminal compatibility
  // Some Windows terminals don't emit SIGINT properly
  const readline = require('readline');
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
    // Clean up readline on close
    child.on('close', () => {
      rl.close();
    });
  }

} else {
  // UNIX PATH: Simple stdio inheritance (works fine, no EBUSY issues)
  const child = spawn(bunPath, [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true
  });

  child.on('error', (err) => {
    console.error('Failed to start pgserve:', err.message);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  // Unix: forward signals to child process normally
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => {
      if (child.pid) {
        process.kill(child.pid, sig);
      }
    });
  });
}
