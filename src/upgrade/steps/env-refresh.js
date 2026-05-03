/**
 * Step 4 — App env file refresh. Regenerates ~/.autopg/<name>.env with
 * canonical port. Verifies SCRAM cred works; warns if rotation needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const name = 'env-refresh';
const CANONICAL_PORT = 8432;

function getAutopgRoot() {
  return process.env.AUTOPG_CONFIG_DIR || process.env.PGSERVE_CONFIG_DIR || `${process.env.HOME}/.autopg`;
}

function listAppEnvFiles() {
  const root = getAutopgRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((f) => f.endsWith('.env') && !f.startsWith('.'))
    .map((f) => path.join(root, f));
}

function parseEnv(content) {
  const out = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function buildUrl({ user, password, port, db }) {
  const enc = (s) => encodeURIComponent(s);
  return `postgresql://${enc(user)}:${enc(password)}@127.0.0.1:${port}/${db}`;
}

function tryConnect(url) {
  try {
    execSync(`psql ${JSON.stringify(url)} -At -c "SELECT 1"`, { stdio: 'pipe', env: process.env });
    return true;
  } catch { return false; }
}

export async function plan() {
  const files = listAppEnvFiles();
  if (files.length === 0) return 'no app .env files found in autopg root';
  return `would verify+rewrite ${files.length} env file(s): ${files.map((f) => path.basename(f)).join(', ')}`;
}

export async function execute({ warn }) {
  const files = listAppEnvFiles();
  if (files.length === 0) return { status: 'SKIP', detail: 'no .env files' };

  let updated = 0, valid = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const env = parseEnv(content);
      const url = env.DATABASE_URL || env.PG_URL || env.POSTGRES_URL;
      if (!url) {
        warn(`[env-refresh] ${path.basename(file)}: no DATABASE_URL key`);
        continue;
      }
      const parsed = new URL(url);
      const newUrl = buildUrl({
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        port: CANONICAL_PORT,
        db: parsed.pathname.replace(/^\//, ''),
      });

      if (tryConnect(newUrl)) {
        valid++;
        if (newUrl !== url) {
          const newContent = content.replace(/^(DATABASE_URL|PG_URL|POSTGRES_URL)=.*/m, `$1=${newUrl}`);
          fs.writeFileSync(file, newContent, { mode: 0o600 });
          updated++;
        }
      } else {
        warn(`[env-refresh] ${path.basename(file)}: SCRAM cred fails — rotate via \`autopg rotate <app>\``);
      }
    } catch (err) {
      warn(`[env-refresh] ${path.basename(file)} failed: ${err.message}`);
    }
  }
  return { status: 'OK', detail: `validated ${valid}/${files.length}, rewrote ${updated}` };
}
