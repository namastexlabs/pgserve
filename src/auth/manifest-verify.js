/**
 * LOCK 1 manifest verifier (Group 5, autopg-distribution-cutover wish).
 *
 * Verifies that an `autopg.json` manifest carries a valid cosign signature
 * before any per-app role/database is provisioned. The detached signature
 * lives at `<manifest_path>.sig` per cosign convention; the verifier
 * cosign-verify-blobs against `cosign.pub` from the publisher key set
 * (`AUTOPG_COSIGN_PUB` env var, falls back to the bundled
 * `keys/cosign.pub`).
 *
 * Behavior matrix:
 *   - signature present + verifies   → { verified: true, sha256 }
 *   - signature present + fails      → throws ManifestVerifyError (S9 text)
 *   - signature missing              → throws ManifestVerifyError (S9 text)
 *   - bypass via --unsafe-unverified <INCIDENT_ID> → returns
 *     { verified: false, sha256, bypass: '<INCIDENT_ID>' } and emits
 *     AUTOPG_MANIFEST_UNSAFE_BYPASS audit row tagging the incident id.
 *
 * Bypass policy (D14, council ship-condition): the bypass is intentionally
 * loud — caller MUST emit the audit row and MUST surface the incident id
 * in CLI output. The verifier handles the audit emission so callers can't
 * forget. The sha256 of the manifest body is captured in both verified and
 * bypass paths so `autopg_meta.autopg_apps.manifest_sha256` always has a
 * value even when verification was skipped.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { audit, AUDIT_EVENTS } from '../audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locked S9 error text. CI's CHANGELOG-lint enforces this exact string is
 * referenced in the wish; keep them in sync.
 */
export const UNSIGNED_ERROR_TEXT =
  'manifest unsigned. add publisher sig or pass `--unsafe-unverified <INCIDENT_ID>`';

export const VERIFY_FAILED_PREFIX =
  'manifest signature verification failed:';

export class ManifestVerifyError extends Error {
  constructor(message, { code, sigPath } = {}) {
    super(message);
    this.name = 'ManifestVerifyError';
    this.code = code || 'EVERIFYFAIL';
    this.sigPath = sigPath;
  }
}

/**
 * Default cosign verifier — shells out to the `cosign` binary. Tests
 * override via `__test_internals.setVerifier()` so we never require a
 * real cosign + key pair in unit tests.
 *
 * @param {{manifestPath: string, sigPath: string, pubKeyPath: string}} args
 * @returns {{ok: boolean, output: string}}
 */
function defaultCosignVerify({ manifestPath, sigPath, pubKeyPath }) {
  const result = spawnSync(
    'cosign',
    [
      'verify-blob',
      '--key', pubKeyPath,
      '--signature', sigPath,
      manifestPath,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) {
    return { ok: false, output: `cosign spawn error: ${result.error.message}` };
  }
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    return { ok: false, output };
  }
  return { ok: true, output };
}

let _verifier = defaultCosignVerify;

export const __test_internals = Object.freeze({
  setVerifier(fn) { _verifier = fn || defaultCosignVerify; },
  resetVerifier() { _verifier = defaultCosignVerify; },
});

/**
 * Resolve the cosign public key path. Order:
 *   1. opts.pubKeyPath (explicit caller override — honors null/'' as
 *      "no key", which short-circuits the lookup so callers can force
 *      the ENOPUBKEY path without env or bundled fallback)
 *   2. AUTOPG_COSIGN_PUB env var
 *   3. <repo>/keys/cosign.pub (bundled with the autopg binary)
 *
 * Returns null when no key can be located — `verifyManifest` treats that
 * as a fast-fail ENOPUBKEY rather than spawning cosign against a missing
 * key (which would otherwise hang for seconds on cosign's transparency-
 * log fetch).
 */
export function resolvePubKeyPath(opts = {}) {
  if (Object.prototype.hasOwnProperty.call(opts, 'pubKeyPath')) {
    return opts.pubKeyPath || null;
  }
  if (process.env.AUTOPG_COSIGN_PUB) return process.env.AUTOPG_COSIGN_PUB;
  const bundled = path.resolve(__dirname, '..', '..', 'keys', 'cosign.pub');
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

/**
 * SHA-256 of the manifest body, captured before verification so the value
 * is always available downstream (audit row, autopg_apps.manifest_sha256).
 */
function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Verify a manifest at `manifestPath`. Throws ManifestVerifyError on
 * failure unless `opts.unsafeUnverified` is set (bypass).
 *
 * @param {string} manifestPath - absolute path to autopg.json
 * @param {object} [opts]
 * @param {string|null} [opts.unsafeUnverified] - incident id; when truthy
 *   the bypass path is taken regardless of sig presence.
 * @param {string} [opts.pubKeyPath] - override the publisher key.
 * @param {string} [opts.sigPath] - override the detached sig location
 *   (default: `<manifestPath>.sig`).
 * @param {object} [opts.audit] - audit emit override (tests).
 * @returns {{verified: boolean, sha256: string, sigPath: string, bypass?: string, output?: string}}
 */
export function verifyManifest(manifestPath, opts = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestVerifyError(`manifest not found: ${manifestPath}`, {
      code: 'ENOMANIFEST',
    });
  }
  const body = fs.readFileSync(manifestPath);
  const sha256 = sha256Of(body);
  const sigPath = opts.sigPath || `${manifestPath}.sig`;
  const auditFn = opts.audit || audit;

  if (opts.unsafeUnverified) {
    auditFn(AUDIT_EVENTS.AUTOPG_MANIFEST_UNSAFE_BYPASS, {
      manifest_path: manifestPath,
      manifest_sha256: sha256,
      incident_id: String(opts.unsafeUnverified),
    });
    return {
      verified: false,
      sha256,
      sigPath,
      bypass: String(opts.unsafeUnverified),
    };
  }

  if (!fs.existsSync(sigPath)) {
    throw new ManifestVerifyError(UNSIGNED_ERROR_TEXT, {
      code: 'EUNSIGNED',
      sigPath,
    });
  }

  const pubKeyPath = resolvePubKeyPath(opts);
  if (!pubKeyPath) {
    throw new ManifestVerifyError(
      `${VERIFY_FAILED_PREFIX} publisher cosign.pub not found (set AUTOPG_COSIGN_PUB or bundle keys/cosign.pub)`,
      { code: 'ENOPUBKEY', sigPath },
    );
  }

  const verifyResult = _verifier({ manifestPath, sigPath, pubKeyPath });
  if (!verifyResult.ok) {
    throw new ManifestVerifyError(
      `${VERIFY_FAILED_PREFIX} ${verifyResult.output || '(no detail from cosign)'}`,
      { code: 'EVERIFYFAIL', sigPath },
    );
  }

  auditFn(AUDIT_EVENTS.AUTOPG_MANIFEST_VERIFIED, {
    manifest_path: manifestPath,
    manifest_sha256: sha256,
    pub_key_path: pubKeyPath,
  });
  return { verified: true, sha256, sigPath, output: verifyResult.output };
}
