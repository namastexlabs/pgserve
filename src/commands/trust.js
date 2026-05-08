/**
 * `pgserve trust` — manage the cosign trust list.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * Subverbs:
 *   pgserve trust list                  show hardcoded + user entries
 *   pgserve trust add <id> [flags]      add a user entry
 *   pgserve trust remove <id>           remove a user entry (refuses hardcoded)
 *
 * `add` flags (all required except where noted):
 *   --issuer <url>                      OIDC issuer URL
 *   --identity-regexp <regex>           sigstore --certificate-identity-regexp value
 *   --publisher <name>                  package.json `pgserve.publisher` (optional)
 *   --description <text>                human-readable summary (optional)
 *
 * Output modes:
 *   default        human-readable table / status line
 *   --json         emit a JSON object on stdout instead
 *
 * Exit codes:
 *   0   success
 *   1   user error (bad flags, unknown id, hardcoded id collision)
 *   2   trust store on disk is malformed and must be repaired by hand
 */

import { listAllTrust, addUserTrust, removeUserTrust } from '../cosign/trust-store.js';

const USAGE = `Usage: pgserve trust <list|add|remove> [args]

  list                                    show hardcoded + user entries
  add <id> --issuer <url> --identity-regexp <re> [--publisher <name>] [--description <text>]
  remove <id>                             remove a user entry (refuses hardcoded)

Common: --json    emit JSON instead of human-readable output`;

function parseFlags(argv) {
  const out = { positional: [], json: false, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.flags.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[name] = true;
      } else {
        out.flags[name] = next;
        i++;
      }
      continue;
    }
    out.positional.push(a);
  }
  return out;
}

function emit(json, payload, humanLine) {
  if (json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else if (humanLine) {
    process.stdout.write(humanLine + '\n');
  }
}

function emitErr(json, code, message) {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
  } else {
    process.stderr.write(`pgserve trust: ${message}\n`);
  }
}

function cmdList(opts) {
  let entries;
  try {
    entries = listAllTrust();
  } catch (err) {
    emitErr(opts.json, err.code || 'ETRUSTSTORE', err.message);
    return 2;
  }
  if (opts.json) {
    emit(true, { ok: true, entries }, null);
    return 0;
  }
  if (entries.length === 0) {
    emit(false, null, 'pgserve trust: no entries');
    return 0;
  }
  const widthId = Math.max(2, ...entries.map((e) => e.id.length));
  const widthSrc = Math.max(6, ...entries.map((e) => e.source.length));
  const widthPub = Math.max(9, ...entries.map((e) => (e.publisher || '').length));
  const header = `${'id'.padEnd(widthId)}  ${'source'.padEnd(widthSrc)}  ${'publisher'.padEnd(widthPub)}  identityRegexp`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${'-'.repeat(header.length)}\n`);
  for (const e of entries) {
    process.stdout.write(
      `${e.id.padEnd(widthId)}  ${e.source.padEnd(widthSrc)}  ${(e.publisher || '').padEnd(widthPub)}  ${e.identityRegexp}\n`,
    );
  }
  return 0;
}

function cmdAdd(opts) {
  const id = opts.positional[1]; // [0]='add', [1]=id
  if (!id) {
    emitErr(opts.json, 'EUSAGE', `add requires an <id> argument\n\n${USAGE}`);
    return 1;
  }
  const issuer = opts.flags.issuer;
  const identityRegexp = opts.flags['identity-regexp'];
  if (typeof issuer !== 'string' || !issuer) {
    emitErr(opts.json, 'EUSAGE', '--issuer <url> is required');
    return 1;
  }
  if (typeof identityRegexp !== 'string' || !identityRegexp) {
    emitErr(opts.json, 'EUSAGE', '--identity-regexp <regex> is required');
    return 1;
  }
  const candidate = {
    id,
    issuer,
    identityRegexp,
    publisher: typeof opts.flags.publisher === 'string' ? opts.flags.publisher : '',
    description: typeof opts.flags.description === 'string' ? opts.flags.description : '',
  };
  let entry;
  try {
    entry = addUserTrust(candidate);
  } catch (err) {
    emitErr(opts.json, err.code || 'ETRUSTADD', err.message);
    return err.code === 'ETRUSTSTORE' ? 2 : 1;
  }
  emit(opts.json, { ok: true, entry }, `pgserve trust: added "${entry.id}"`);
  return 0;
}

function cmdRemove(opts) {
  const id = opts.positional[1];
  if (!id) {
    emitErr(opts.json, 'EUSAGE', `remove requires an <id> argument\n\n${USAGE}`);
    return 1;
  }
  let removed;
  try {
    removed = removeUserTrust(id);
  } catch (err) {
    emitErr(opts.json, err.code || 'ETRUSTREMOVE', err.message);
    return err.code === 'ETRUSTSTORE' ? 2 : 1;
  }
  if (!removed) {
    emitErr(opts.json, 'ENOENT', `no user trust entry with id "${id}"`);
    return 1;
  }
  emit(opts.json, { ok: true, removed: id }, `pgserve trust: removed "${id}"`);
  return 0;
}

export async function runTrust(argv = []) {
  const opts = parseFlags(argv);
  if (opts.flags.help || opts.positional.length === 0) {
    process.stdout.write(USAGE + '\n');
    return opts.flags.help ? 0 : 1;
  }
  const verb = opts.positional[0];
  switch (verb) {
    case 'list':
      return cmdList(opts);
    case 'add':
      return cmdAdd(opts);
    case 'remove':
    case 'rm':
      return cmdRemove(opts);
    default:
      emitErr(opts.json, 'EUSAGE', `unknown subverb "${verb}"\n\n${USAGE}`);
      return 1;
  }
}

export const __testInternals = Object.freeze({ parseFlags });
