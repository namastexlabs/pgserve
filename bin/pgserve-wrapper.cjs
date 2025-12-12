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

const scriptPath = path.join(__dirname, 'pglite-server.js');

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
