#!/usr/bin/env node
/**
 * pgserve wrapper - Finds and spawns the prebuilt pgserve binary
 *
 * This wrapper enables `npx pgserve` to work by finding and running
 * the prebuilt binary for the current platform from @pgserve/* packages.
 *
 * No bun runtime dependency required - binaries are self-contained.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Detect platform
const platform = process.platform;
const arch = process.arch;
const isWindows = platform === 'win32';

// Map to package names
function getPlatformPackage() {
  if (platform === 'win32' && arch === 'x64') return '@pgserve/windows-x64';
  if (platform === 'linux' && arch === 'x64') return '@pgserve/linux-x64';
  if (platform === 'linux' && arch === 'arm64') return '@pgserve/linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return '@pgserve/darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return '@pgserve/darwin-arm64';
  return null;
}

const platformPkg = getPlatformPackage();
const binaryName = isWindows ? 'pgserve.exe' : 'pgserve';

if (!platformPkg) {
  console.error(`Error: Unsupported platform: ${platform}-${arch}`);
  console.error('');
  console.error('Supported platforms:');
  console.error('  - Windows x64');
  console.error('  - Linux x64');
  console.error('  - Linux ARM64');
  console.error('  - macOS x64');
  console.error('  - macOS ARM64 (Apple Silicon)');
  process.exit(1);
}

// Try multiple locations for cross-platform compatibility
const locations = [
  // Hoisted to top-level node_modules (npm default behavior)
  path.join(__dirname, '..', '..', platformPkg, binaryName),
  // Standard location when not hoisted
  path.join(__dirname, '..', 'node_modules', platformPkg, binaryName),
  // pnpm/yarn PnP style
  path.join(__dirname, '..', '..', '.pnpm', 'node_modules', platformPkg, binaryName),
  // Hoisted .bin symlink
  path.join(__dirname, '..', '..', '.bin', binaryName),
  // Local .bin
  path.join(__dirname, '..', 'node_modules', '.bin', binaryName),
];

const binaryPath = locations.find(p => fs.existsSync(p));

if (!binaryPath) {
  console.error(`Error: Could not find pgserve binary for ${platform}-${arch}`);
  console.error('');
  console.error(`Expected package: ${platformPkg}`);
  console.error('');
  console.error('Tried locations:');
  locations.forEach(l => console.error(`  - ${l}`));
  console.error('');
  console.error('This platform package may not have been installed.');
  console.error('Try reinstalling: npm install pgserve');
  process.exit(1);
}

// Spawn the binary directly - no need for bun runtime
if (isWindows) {
  // WINDOWS: Use pipes for explicit handle control (prevents EBUSY errors)
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  // Manually pipe stdio
  process.stdin.on('error', () => {});
  child.stdin.on('error', () => {});

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
    // Explicitly destroy streams to release file handles
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

    child.removeAllListeners();

    setImmediate(() => {
      process.exit(signal ? 1 : (code ?? 0));
    });
  });

  // Windows signal handling with taskkill
  process.on('SIGINT', () => {
    if (child.pid) {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, {
          stdio: 'ignore',
          windowsHide: true
        });
      } catch {
        // Process may have already exited
      }
    }
  });

  // Handle Ctrl+C via readline for Windows terminal compatibility
  const readline = require('readline');
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
    child.on('close', () => {
      rl.close();
    });
  }

} else {
  // UNIX: Simple stdio inheritance
  const child = spawn(binaryPath, process.argv.slice(2), {
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

  // Unix: forward signals to child process
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => {
      if (child.pid) {
        process.kill(child.pid, sig);
      }
    });
  });
}
