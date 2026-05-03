/**
 * Step 1 — Port reconciliation. Ensures pgserve listens on canonical 8432.
 * If running on a different port, stop and relaunch on 8432. Idempotent.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'port-reconcile';
const CANONICAL_PORT = 8432;

function readPostmasterPid(dataDir) {
  try {
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

export async function plan() {
  const info = readPostmasterPid(getDataDir());
  if (!info) return 'no running pgserve detected — nothing to reconcile';
  if (info.port === CANONICAL_PORT) return `already on port ${CANONICAL_PORT}, no action needed`;
  return `would stop pgserve PID ${info.pid} (port ${info.port}) and relaunch on ${CANONICAL_PORT}`;
}

export async function execute({ log, warn }) {
  const info = readPostmasterPid(getDataDir());
  if (!info) return { status: 'SKIP', detail: 'no running pgserve' };
  if (info.port === CANONICAL_PORT) return { status: 'SKIP', detail: `already on ${CANONICAL_PORT}` };

  log(`stopping pgserve PID ${info.pid} (port ${info.port})`);
  try {
    execSync(`pm2 restart pgserve --update-env -- --port ${CANONICAL_PORT}`, { stdio: 'pipe' });
    return { status: 'OK', detail: `pm2 restart pgserve on port ${CANONICAL_PORT}` };
  } catch (pm2Err) {
    warn(`pm2 restart failed (${pm2Err.message}) — falling back to direct pg_ctl`);
    try {
      execSync(`pg_ctl -D ${getDataDir()} -m fast stop`, { stdio: 'pipe' });
      return { status: 'OK', detail: `stopped pgserve; relaunch via pm2 or autopg install` };
    } catch (ctlErr) {
      throw new Error(`port reconcile failed: pm2 (${pm2Err.message}) and pg_ctl (${ctlErr.message})`);
    }
  }
}
