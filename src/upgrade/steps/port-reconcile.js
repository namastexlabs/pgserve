/**
 * Step 1 — Port reconciliation.
 *
 * Ensures pgserve listens on the canonical port (8432). If a running
 * pgserve is bound to a different port, stop it and relaunch on 8432.
 *
 * Idempotent: if already on 8432 (or not running), SKIP.
 *
 * Why: autopg-v22 partial roll-out launched pgserve on 9432 (default of
 * the new postgres-server.js multi-tenant mode after proxy deletion).
 * Existing consumers (omni-api, genie-serve) hardcode 8432 and silently
 * fail to connect. This step restores the user-facing contract.
 */

const { execSync } = require('node:child_process');

const CANONICAL_PORT = 8432;

function readPostmasterPid(dataDir) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const content = fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8');
    const lines = content.trim().split('\n');
    return { pid: parseInt(lines[0], 10), port: parseInt(lines[3], 10) };
  } catch {
    return null;
  }
}

function getDataDir() {
  return process.env.PGSERVE_DATA || `${process.env.HOME}/.pgserve/data`;
}

async function plan() {
  const info = readPostmasterPid(getDataDir());
  if (!info) return 'no running pgserve detected — nothing to reconcile';
  if (info.port === CANONICAL_PORT) return `already on port ${CANONICAL_PORT}, no action needed`;
  return `would stop pgserve PID ${info.pid} (port ${info.port}) and relaunch on ${CANONICAL_PORT}`;
}

async function execute({ log, warn }) {
  const info = readPostmasterPid(getDataDir());
  if (!info) return { status: 'SKIP', detail: 'no running pgserve' };
  if (info.port === CANONICAL_PORT) return { status: 'SKIP', detail: `already on ${CANONICAL_PORT}` };

  log(`stopping pgserve PID ${info.pid} (port ${info.port})`);
  try {
    // Prefer pm2 if pgserve is supervised; falls through to direct signal.
    execSync(`pm2 restart pgserve --update-env -- --port ${CANONICAL_PORT}`, { stdio: 'pipe' });
    return { status: 'OK', detail: `pm2 restart pgserve on port ${CANONICAL_PORT}` };
  } catch (pm2Err) {
    warn(`pm2 restart failed (${pm2Err.message}) — falling back to direct pg_ctl`);
    try {
      execSync(`pg_ctl -D ${getDataDir()} -m fast stop`, { stdio: 'pipe' });
      // Caller will need to relaunch via `autopg install` or pm2 — we don't auto-launch
      // because the launch invocation differs by topology (single-tenant vs multi-tenant).
      return { status: 'OK', detail: `stopped pgserve; relaunch via pm2 or autopg install` };
    } catch (ctlErr) {
      throw new Error(`could not reconcile port: pm2 (${pm2Err.message}) and pg_ctl (${ctlErr.message}) both failed`);
    }
  }
}

module.exports = { name: 'port-reconcile', plan, execute };
