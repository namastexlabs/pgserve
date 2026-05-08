/**
 * User-extensible cosign trust store at `~/.pgserve/trust/identities.json`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3
 * (the `pgserve trust add/list/remove` CLI surface).
 *
 * Hardcoded trust roots live in `src/cosign/trust-list.js` and ship in the
 * binary; operators cannot remove or override them. This module owns the
 * separate, mutable layer where operators add their own publishers (e.g.
 * a private fork of pgserve, an internal release workflow).
 *
 * File format (v1):
 *   {
 *     "schemaVersion": 1,
 *     "entries": [
 *       {
 *         "id":             "<short-stable-id>",
 *         "publisher":      "<package-json-pgserve-publisher>",
 *         "issuer":         "<oidc-issuer-url>",
 *         "identityRegexp": "<sigstore-cert-identity-regexp>",
 *         "description":    "<human-readable, optional>",
 *         "addedAt":        "<iso-8601>"
 *       }
 *     ]
 *   }
 *
 * Write semantics: atomic via tmp-file + rename, file mode 0600.
 * Read semantics: missing file or empty contents → `{ schemaVersion: 1, entries: [] }`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TRUSTED_IDENTITIES, listHardcodedTrust } from './trust-list.js';

const SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const TRUST_FILE_NAME = 'identities.json';

export function getTrustDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.pgserve', 'trust');
}

export function getTrustFilePath(homeDir = os.homedir()) {
  return path.join(getTrustDir(homeDir), TRUST_FILE_NAME);
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

/**
 * Read the user trust store. Returns the parsed object on success, or an
 * empty store if the file is missing. Throws on parse failure / bad shape.
 */
export function readTrustStore({ homeDir = os.homedir() } = {}) {
  const file = getTrustFilePath(homeDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw err;
  }
  if (!raw.trim()) return emptyStore();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`pgserve trust store at ${file} is not valid JSON: ${err.message}`);
    e.code = 'ETRUSTSTORE';
    throw e;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    const e = new Error(`pgserve trust store at ${file} is missing the entries array`);
    e.code = 'ETRUSTSTORE';
    throw e;
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    const e = new Error(
      `pgserve trust store schemaVersion ${parsed.schemaVersion} unsupported (expected ${SCHEMA_VERSION})`,
    );
    e.code = 'ETRUSTSTORE';
    throw e;
  }
  // Per-entry shape check. Without this, a manually-edited
  // identities.json containing `{"entries":[{}]}` would slip past the
  // store-level guard and crash the formatter in `pgserve trust list`
  // with a generic TypeError on first field access — losing the
  // documented exit-2 ("malformed store") path. Fail fast here with
  // the same ETRUSTSTORE code so downstream callers (the CLI command,
  // `pgserve verify`, future provisioner) can branch on it uniformly.
  for (let i = 0; i < parsed.entries.length; i++) {
    const e = parsed.entries[i];
    if (!e || typeof e !== 'object'
        || typeof e.id !== 'string' || e.id.length === 0
        || typeof e.issuer !== 'string' || e.issuer.length === 0
        || typeof e.identityRegexp !== 'string' || e.identityRegexp.length === 0) {
      const err = new Error(
        `pgserve trust store at ${file}: entries[${i}] is missing required fields ` +
          `(id, issuer, identityRegexp)`,
      );
      err.code = 'ETRUSTSTORE';
      throw err;
    }
  }
  return parsed;
}

/**
 * Atomically write the trust store. Creates the directory if absent.
 */
export function writeTrustStore(store, { homeDir = os.homedir() } = {}) {
  if (!store || typeof store !== 'object' || !Array.isArray(store.entries)) {
    throw new Error('writeTrustStore: store must be { schemaVersion, entries }');
  }
  const dir = getTrustDir(homeDir);
  const file = getTrustFilePath(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.tmp.${process.pid}`;
  const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries: store.entries }, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best-effort on platforms that ignore mode */
  }
}

/**
 * Validate a single user entry candidate. Throws on bad shape.
 * Returns the normalized entry (trimmed strings, computed addedAt).
 */
export function validateEntry(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('trust entry must be an object');
  }
  const required = ['id', 'issuer', 'identityRegexp'];
  for (const key of required) {
    const v = candidate[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`trust entry field "${key}" must be a non-empty string`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(candidate.id)) {
    throw new Error(
      `trust entry id "${candidate.id}" must match /^[a-z0-9][a-z0-9._-]{0,63}$/i`,
    );
  }
  // Normalize id to lowercase. The regex accepts upper-case (/i flag) so
  // operators can paste pretty identifiers, but storage + lookup are
  // case-insensitive — otherwise an entry typed "Foo" could shadow a
  // hardcoded "foo" silently. Normalizing once on write keeps the
  // hardcoded-shadow check simple and makes `trust remove FOO` idempotent
  // with `trust add foo`.
  const normalizedId = candidate.id.toLowerCase();
  // Validate the identityRegexp parses as JS regex (cosign uses a similar
  // RE2-ish dialect; this catches the obvious garbage while letting valid
  // sigstore patterns through).
  try {
    new RegExp(candidate.identityRegexp);
  } catch (err) {
    throw new Error(`trust entry identityRegexp is not a valid regex: ${err.message}`);
  }
  return {
    id: normalizedId,
    publisher: typeof candidate.publisher === 'string' ? candidate.publisher : '',
    issuer: candidate.issuer,
    identityRegexp: candidate.identityRegexp,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    addedAt: typeof candidate.addedAt === 'string' && candidate.addedAt
      ? candidate.addedAt
      : new Date().toISOString(),
  };
}

function isHardcodedId(id) {
  // Compare lowercase-against-lowercase. validateEntry normalizes new
  // user entries to lowercase; hardcoded ids in TRUSTED_IDENTITIES
  // already use lowercase by convention, but we lowercase both sides to
  // make the predicate symmetric and immune to a typo in the hardcoded
  // table from leaking through.
  const needle = id.toLowerCase();
  return TRUSTED_IDENTITIES.some((e) => e.id.toLowerCase() === needle);
}

/**
 * Add a user trust entry. Refuses to shadow a hardcoded id.
 * Returns the normalized entry that was written.
 */
export function addUserTrust(candidate, opts = {}) {
  const entry = validateEntry(candidate);
  if (isHardcodedId(entry.id)) {
    const e = new Error(
      `cannot add "${entry.id}" — id collides with a hardcoded trust root and would shadow it`,
    );
    e.code = 'ETRUSTSHADOW';
    throw e;
  }
  const store = readTrustStore(opts);
  const existing = store.entries.findIndex((x) => x.id === entry.id);
  if (existing >= 0) {
    store.entries[existing] = entry;
  } else {
    store.entries.push(entry);
  }
  writeTrustStore(store, opts);
  return entry;
}

/**
 * Remove a user trust entry by id. Refuses to remove hardcoded entries.
 * Returns true on success, false if the id was not in the user store.
 */
export function removeUserTrust(id, opts = {}) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('removeUserTrust: id must be a non-empty string');
  }
  // Lowercase normalization mirrors validateEntry — `trust remove FOO`
  // must find the entry that `trust add foo` (or `trust add Foo`) wrote.
  const normalizedId = id.toLowerCase();
  if (isHardcodedId(normalizedId)) {
    const e = new Error(`cannot remove "${normalizedId}" — hardcoded trust roots are not removable`);
    e.code = 'ETRUSTHARDCODED';
    throw e;
  }
  const store = readTrustStore(opts);
  const before = store.entries.length;
  store.entries = store.entries.filter((x) => x.id !== normalizedId);
  if (store.entries.length === before) return false;
  writeTrustStore(store, opts);
  return true;
}

/**
 * Combined view: hardcoded entries followed by user entries, each tagged
 * with `source` and `removable`. Used by `pgserve trust list`.
 */
export function listAllTrust(opts = {}) {
  const hardcoded = listHardcodedTrust();
  const store = readTrustStore(opts);
  const user = store.entries.map((entry) => ({ ...entry, source: 'user', removable: true }));
  return [...hardcoded, ...user];
}

export const __testInternals = Object.freeze({ SCHEMA_VERSION, FILE_MODE, DIR_MODE });
