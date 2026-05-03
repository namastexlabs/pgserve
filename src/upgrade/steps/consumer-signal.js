/**
 * Step 5 — Consumer reconnect signal. Touches ~/.autopg/state/upgrade.signal
 * with epoch + autopg version. Consumers (omni-api, genie-serve) opt-in via fs.watch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'consumer-signal';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

function getAutopgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch { return 'unknown'; }
}

export async function plan() {
  return `would write upgrade signal at ${path.join(getAutopgRoot(), 'state', 'upgrade.signal')}`;
}

export async function execute() {
  const signalDir = path.join(getAutopgRoot(), 'state');
  fs.mkdirSync(signalDir, { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    epoch_ms: Date.now(),
    autopg_version: getAutopgVersion(),
    canonical_port: 8432,
  };
  const signalPath = path.join(signalDir, 'upgrade.signal');
  fs.writeFileSync(signalPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  return { status: 'OK', detail: `signal written at ${signalPath}` };
}
