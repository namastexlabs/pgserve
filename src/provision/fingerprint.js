/**
 * Fingerprint resolver for `pgserve provision`.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 3.
 *
 * Goal: deterministically map a consumer location (cwd / explicit path /
 * package.json contents) to a stable fingerprint string + the metadata
 * `pgserve provision` needs to write a row into `pgserve_meta`.
 *
 * Fingerprint precedence (matches Decision in WISH.md §2.4):
 *   1. If a package.json is found and declares `pgserve.fingerprint`,
 *      use that string verbatim. (Operator escape hatch — pinned across
 *      moves.)
 *   2. Else if a package.json declares `name` + `version`, fingerprint =
 *      sha256(`<name>@<version>`).
 *   3. Else if a package.json declares `name` only, fingerprint =
 *      sha256(`<name>`).
 *   4. Else (no package.json or empty), fingerprint = sha256(absolute
 *      cwd path). This is the "fallback fingerprint" the wish describes.
 *
 * `publisher` resolution:
 *   - prefers `package.json#pgserve.publisher`
 *   - falls back to `package.json#name`
 *   - empty string when no package.json was found
 *
 * `sourcePath` is always the absolute filesystem path (cwd or supplied)
 * — used by gc to detect "directory removed" orphans.
 *
 * Pure function: no postgres I/O, no network, no globals. Safe to call
 * 1000x in a tight loop during tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * @typedef {Object} ResolvedFingerprint
 * @property {string} fingerprint   sha256-hex (64 chars) OR a literal
 *                                  string if pgserve.fingerprint was set.
 * @property {string} sourcePath    absolute path that was inspected.
 * @property {string} publisher     resolved publisher; '' when unknown.
 * @property {string} kind          'pinned' | 'name+version' | 'name' | 'cwd'
 * @property {object} packageJson   the parsed object; null when absent.
 */

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function readPackageJson(absDir) {
  const candidate = path.join(absDir, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(candidate, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    const e = new Error(`pgserve provision: package.json at ${candidate} is not valid JSON: ${err.message}`);
    e.code = 'EFINGERPRINTPKG';
    throw e;
  }
}

/**
 * Resolve a fingerprint for the given directory (defaults to cwd).
 * @param {object} opts
 * @param {string} [opts.cwd]            absolute or relative path to inspect
 * @param {string} [opts.explicit]       caller-supplied fingerprint; bypasses package.json
 * @returns {ResolvedFingerprint}
 */
export function resolveFingerprint(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  if (typeof opts.explicit === 'string' && opts.explicit.length > 0) {
    // Caller passed an explicit fingerprint (CLI flag / config file).
    // We still load package.json so callers get the full publisher
    // metadata, but the fingerprint itself comes from the operator.
    const pkg = readPackageJson(cwd);
    return {
      fingerprint: opts.explicit,
      sourcePath: cwd,
      publisher: derivePublisher(pkg),
      kind: 'pinned',
      packageJson: pkg,
    };
  }
  const pkg = readPackageJson(cwd);
  if (pkg && typeof pkg.pgserve === 'object' && pkg.pgserve !== null
      && typeof pkg.pgserve.fingerprint === 'string'
      && pkg.pgserve.fingerprint.length > 0) {
    return {
      fingerprint: pkg.pgserve.fingerprint,
      sourcePath: cwd,
      publisher: derivePublisher(pkg),
      kind: 'pinned',
      packageJson: pkg,
    };
  }
  if (pkg && typeof pkg.name === 'string' && pkg.name.length > 0) {
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return {
        fingerprint: sha256Hex(`${pkg.name}@${pkg.version}`),
        sourcePath: cwd,
        publisher: derivePublisher(pkg),
        kind: 'name+version',
        packageJson: pkg,
      };
    }
    return {
      fingerprint: sha256Hex(pkg.name),
      sourcePath: cwd,
      publisher: derivePublisher(pkg),
      kind: 'name',
      packageJson: pkg,
    };
  }
  return {
    fingerprint: sha256Hex(cwd),
    sourcePath: cwd,
    publisher: '',
    kind: 'cwd',
    packageJson: null,
  };
}

function derivePublisher(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';
  if (typeof pkg.pgserve === 'object' && pkg.pgserve !== null
      && typeof pkg.pgserve.publisher === 'string'
      && pkg.pgserve.publisher.length > 0) {
    return pkg.pgserve.publisher;
  }
  if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  return '';
}

export const __testInternals = Object.freeze({ sha256Hex, derivePublisher, readPackageJson });
