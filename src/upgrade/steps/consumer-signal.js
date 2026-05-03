/**
 * Step 5 — Consumer reconnect signal.
 *
 * Touches ~/.autopg/state/upgrade.signal with epoch timestamp + autopg
 * version. Consumers (omni-api, genie-serve) opt-in by watching this
 * file via fs.watch and respond with `pm2 restart self` (or equivalent
 * reconnect logic).
 *
 * Decoupled by design: autopg doesn't need to know which consumers
 * exist. Consumers add fs.watch in a follow-up — until then this step
 * is harmless.
 *
 * Idempotent: just rewrites the signal file with current timestamp.
 */

const fs = require('node:fs');
const path = require('node:path');

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

function getAutopgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function plan() {
  const signalDir = path.join(getAutopgRoot(), 'state');
  return `would write upgrade signal at ${path.join(signalDir, 'upgrade.signal')}`;
}

async function execute({ log }) {
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

module.exports = { name: 'consumer-signal', plan, execute };
