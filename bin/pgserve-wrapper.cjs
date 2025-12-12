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

// Spawn bun with the actual script, inherit all stdio
// IMPORTANT: Do NOT use detached mode - wrapper must wait for child to fully terminate
// Using detached with stdio:'inherit' causes file handle inheritance issues on Windows
const child = spawn(bunPath, [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true
});

child.on('error', (err) => {
  console.error('Failed to start pgserve:', err.message);
  process.exit(1);
});

// Safety timeout: force exit if 'close' event never fires after 'exit'
let forceExitTimeout = null;

child.on('exit', () => {
  // Give 5 seconds for 'close' event after 'exit'
  forceExitTimeout = setTimeout(() => {
    console.error('Warning: Child process did not close cleanly, forcing exit');
    process.exit(1);
  }, 5000);
});

// Use 'close' event instead of 'exit' - fires AFTER all stdio streams are closed
// This is critical for Windows where file handles may remain locked after 'exit' fires
child.on('close', (code, signal) => {
  // Clear the safety timeout
  if (forceExitTimeout) {
    clearTimeout(forceExitTimeout);
  }

  // On Windows, use SYNCHRONOUS delay to ensure all file handles are released
  // This prevents EBUSY errors when npx tries to clean up the cache
  // NOTE: async/await does NOT work in EventEmitter callbacks - Node ignores the Promise
  if (isWindows) {
    const delay = 200; // ms - enough for Windows kernel to release handles
    const start = Date.now();
    while (Date.now() - start < delay) {
      // Synchronous busy-wait - actually blocks unlike async setTimeout
    }
  }

  if (signal) {
    // On Windows, can't reliably re-raise Unix signals
    if (isWindows) {
      process.exit(1);
    } else {
      process.kill(process.pid, signal);
    }
  } else {
    process.exit(code ?? 0);
  }
});

// Platform-specific signal handling
if (isWindows) {
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
  }
} else {
  // Unix: forward signals to child process normally
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
    process.on(signal, () => {
      if (child.pid) {
        process.kill(child.pid, signal);
      }
    });
  });
}
