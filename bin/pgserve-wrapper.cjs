#!/usr/bin/env node
/**
 * pgserve wrapper - Finds and spawns bun runtime from node_modules
 *
 * This wrapper enables `npx pgserve` to work without requiring
 * users to install bun globally. The bun runtime is bundled as
 * an npm dependency and this wrapper finds and invokes it.
 */

const { spawn } = require('child_process');
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
const child = spawn(bunPath, [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  // Detach on Windows to prevent handle inheritance and EBUSY errors during npx cleanup
  detached: isWindows
});

// On Windows, unreference the child to allow wrapper to exit independently
if (isWindows) {
  child.unref();
}

child.on('error', (err) => {
  console.error('Failed to start pgserve:', err.message);
  process.exit(1);
});

child.on('exit', async (code, signal) => {
  // On Windows, wait briefly for all file handles to be released
  // This prevents EBUSY errors when npx tries to clean up the cache
  if (isWindows) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

// Forward signals to child process
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
  process.on(signal, () => {
    if (child.pid) {
      process.kill(child.pid, signal);
    }
  });
});
