/**
 * Cosign keyless OIDC binary verifier.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Per Decision P5 (locked), we shell out to the `cosign` CLI rather than
 * vendoring sigstore-rs. Verification model:
 *
 *   - Each binary distributed by an automagik release ships with a
 *     paired Sigstore bundle file at `<binary>.bundle` (modern keyless
 *     OIDC attestation, JSON-encoded).
 *   - We invoke `cosign verify-blob --bundle <bundle>
 *     --certificate-identity-regexp <re> --certificate-oidc-issuer <iss>
 *     <binary>` — once per entry in the trust list.
 *   - First entry that exits 0 wins. We return its identity + tier.
 *   - If every entry fails, we surface the most-specific cosign diagnostic
 *     (the last exit) so the operator knows which trust root we tried.
 *
 * Resolution of the cosign executable:
 *   1. Caller-supplied `cosignBin` (used by tests + `--cosign-bin` flag)
 *   2. `cosign` on `$PATH`
 *   3. Cached static binary at `~/.pgserve/bin/cosign`
 *   4. Download official static binary from sigstore release (offline by
 *      default — only triggered when `allowFetch: true` is passed)
 *
 * Returns a tagged union:
 *   { ok: true,  identity, tier, sha256, cosignBin, bundle }
 *   { ok: false, reason, detail?, identityChain? }
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TRUSTED_IDENTITIES } from './trust-list.js';

export const COSIGN_TIER = 'cosign_signed';
export const COSIGN_BIN_DIR = path.join(os.homedir(), '.pgserve', 'bin');
export const COSIGN_BIN_FILE = path.join(COSIGN_BIN_DIR, process.platform === 'win32' ? 'cosign.exe' : 'cosign');

const COSIGN_RELEASE_VERSION = 'v2.2.4';
const COSIGN_RELEASE_BASE = `https://github.com/sigstore/cosign/releases/download/${COSIGN_RELEASE_VERSION}`;

/**
 * Compute sha256 of a file. Returns lowercase hex.
 */
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

/**
 * Candidate sidecar bundle paths for a given binary path, in priority
 * order. First existing file wins. When none exist, the first candidate
 * (`<binary>.bundle`) is returned so the caller's existing
 * `bundle-missing` error path keeps the same operator-facing message
 * shape.
 *
 * Three conventions are accepted:
 *
 *   1. `<binary>.bundle` — `cosign sign-blob --bundle` default;
 *      pgserve's own producer convention.
 *   2. `<binary-stem>.intoto.jsonl` — slsa-github-generator
 *      per-artifact provenance (writes `<artifact>.intoto.jsonl` when
 *      provenance-name interpolates the artifact stem). The stem is
 *      computed by stripping `.tgz` (the only archive ext used in the
 *      automagik-cohort cosign trust loop today).
 *   3. `<dirname>/provenance.intoto.jsonl` — slsa-github-generator
 *      generic-provenance default (single sibling per release upload).
 *      This is what `automagik-dev/genie` ships today (verified via
 *      `gh release view` against v4.260508.3+).
 *
 * Why fall-through, not single-shape: CV-VERIFY-BUNDLE-NAMING (qa
 * Wave-B-live finding 2026-05-09). pgserve's prior single-shape
 * resolver returned literal `<binary>.bundle` and failed every
 * `pgserve verify` against producer-side artifacts that ship per the
 * standards-compliant `intoto.jsonl` conventions. Consumer-side
 * fall-through preserves the producer's standards conformance instead
 * of forcing every producer-side wave (A/B/C) into a non-standard
 * `.bundle` rename.
 */
export function resolveBundleCandidates(binaryPath) {
  const stem = binaryPath.replace(/\.tgz$/, '');
  return [
    `${binaryPath}.bundle`,
    `${stem}.intoto.jsonl`,
    path.join(path.dirname(binaryPath), 'provenance.intoto.jsonl'),
  ];
}

/**
 * Resolve the sidecar bundle path for a given binary path. Returns the
 * first existing candidate; when none exist, returns the first
 * candidate (`<binary>.bundle`) so the existing `bundle-missing` error
 * path retains its operator-facing message shape.
 *
 * Callers that need the full candidate list (e.g. for diagnostics) can
 * use `resolveBundleCandidates` directly.
 */
export function resolveBundlePath(binaryPath) {
  const candidates = resolveBundleCandidates(binaryPath);
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/**
 * Resolve which `cosign` executable to use. Returns a string path or null
 * if no cosign is available and `allowFetch: false`.
 *
 * PATH probing is implemented in-process (rather than shelling out to
 * `which` / `where`) so the resolver works inside test harnesses that
 * scrub PATH down to a single stub directory.
 */
export function resolveCosignBin({ cosignBin, allowFetch = false } = {}) {
  if (cosignBin && fs.existsSync(cosignBin)) return cosignBin;

  const fromPath = lookupOnPath(process.platform === 'win32' ? 'cosign.exe' : 'cosign');
  if (fromPath) return fromPath;

  // Cached static binary.
  if (fs.existsSync(COSIGN_BIN_FILE)) return COSIGN_BIN_FILE;

  if (!allowFetch) return null;

  try {
    return fetchCosignBin();
  } catch {
    return null;
  }
}

function lookupOnPath(name) {
  const PATH = process.env.PATH || '';
  if (!PATH) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = PATH.split(sep).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        // On POSIX, ensure it's executable; on Windows, file existence is enough.
        if (process.platform === 'win32') return candidate;
        if ((stat.mode & 0o111) !== 0) return candidate;
      }
    } catch {
      // missing or stat error — try next dir
    }
  }
  return null;
}

/**
 * Download the official cosign static binary into `~/.pgserve/bin/cosign`.
 * Synchronous — used by `pgserve verify` when no cosign is on PATH and the
 * operator opts into the fetch (see Decision P5: "if cosign not on PATH,
 * pgserve install shells out to a downloader to fetch the official static
 * binary into ~/.pgserve/bin/cosign").
 *
 * Network-dependent. Throws on failure. Tests stub via `cosignBin` instead
 * of this code path.
 */
export function fetchCosignBin({
  releaseBase = COSIGN_RELEASE_BASE,
  targetFile = COSIGN_BIN_FILE,
  targetDir = COSIGN_BIN_DIR,
} = {}) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  const assetName = pickCosignAssetName();
  const url = `${releaseBase}/${assetName}`;
  const tmp = `${targetFile}.tmp.${process.pid}`;
  downloadToFileSync(url, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, targetFile);
  return targetFile;
}

function pickCosignAssetName() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  if (process.platform === 'darwin') return `cosign-darwin-${arch}`;
  if (process.platform === 'win32') return `cosign-windows-${arch}.exe`;
  return `cosign-linux-${arch}`;
}

function downloadToFileSync(url, destPath) {
  // Node has no built-in synchronous HTTP. We fall back to spawning curl
  // since this only runs once per host (cached afterward) and curl is
  // ubiquitous on the supported platforms.
  const curl = spawnSync('curl', ['-fsSL', '-o', destPath, url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (curl.status === 0) return;
  // Fallback: try wget.
  const wget = spawnSync('wget', ['-qO', destPath, url], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (wget.status === 0) return;
  throw new Error(
    `cosign-verify: failed to download cosign from ${url} (curl exit ${curl.status}, wget exit ${wget?.status ?? 'n/a'})`,
  );
}

/**
 * Verify a binary with cosign.
 *
 * @param {string} binaryPath
 * @param {object} [options]
 * @param {string} [options.cosignBin]   override cosign executable
 * @param {string} [options.bundlePath]  override bundle sidecar path
 * @param {Array}  [options.trustList]   override hardcoded TRUSTED_IDENTITIES
 * @param {boolean}[options.allowFetch]  allow fetching the cosign binary if missing
 * @returns {{ ok: true, identity, tier, sha256, cosignBin, bundle, identityChain }
 *         | { ok: false, reason, detail?, identityChain? }}
 */
export function verifyBinary(binaryPath, options = {}) {
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    return { ok: false, reason: 'invalid-args', detail: 'binaryPath required' };
  }
  if (!fs.existsSync(binaryPath)) {
    return { ok: false, reason: 'binary-missing', detail: binaryPath };
  }
  let stat;
  try {
    stat = fs.statSync(binaryPath);
  } catch (err) {
    return { ok: false, reason: 'binary-unreadable', detail: err.message };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'binary-not-a-file', detail: binaryPath };
  }

  const bundlePath = options.bundlePath || resolveBundlePath(binaryPath);
  if (!fs.existsSync(bundlePath)) {
    // CV-VERIFY-BUNDLE-NAMING (v2.6.3): when none of the three
    // candidates exist, surface the full list in the error detail so
    // operators see exactly which paths pgserve probed. The
    // bundle-missing reason code is unchanged so any log-grep wired
    // against it keeps working.
    const probed = options.bundlePath
      ? [bundlePath]
      : resolveBundleCandidates(binaryPath);
    return {
      ok: false,
      reason: 'bundle-missing',
      detail:
        `expected sigstore bundle for ${binaryPath} — probed: ${probed.join(', ')}. `
        + `Pass --bundle <path> to override, or run `
        + `\`cosign sign-blob --bundle ${binaryPath}.bundle ${binaryPath}\` to attest.`,
    };
  }

  const trustList = options.trustList || TRUSTED_IDENTITIES;
  if (!Array.isArray(trustList) || trustList.length === 0) {
    return { ok: false, reason: 'empty-trust-list' };
  }

  const cosignBin = resolveCosignBin({
    cosignBin: options.cosignBin,
    allowFetch: options.allowFetch === true,
  });
  if (!cosignBin) {
    return {
      ok: false,
      reason: 'cosign-missing',
      detail:
        'no `cosign` binary on $PATH or in ~/.pgserve/bin/cosign — install cosign or rerun with --allow-fetch',
    };
  }

  const sha256 = sha256File(binaryPath);
  const identityChain = [];
  let lastFailure = null;

  for (const identity of trustList) {
    if (!identity || !identity.id || !identity.issuer || !identity.identityRegexp) {
      identityChain.push({ id: identity?.id || '<malformed>', status: 'skipped' });
      continue;
    }
    const result = invokeCosign({
      cosignBin,
      bundlePath,
      binaryPath,
      identity,
    });
    if (result.ok) {
      identityChain.push({ id: identity.id, status: 'matched' });
      return {
        ok: true,
        identity: identity.id,
        publisher: identity.publisher,
        tier: COSIGN_TIER,
        sha256,
        cosignBin,
        bundle: bundlePath,
        identityChain,
      };
    }
    identityChain.push({ id: identity.id, status: 'rejected', exitCode: result.exitCode });
    lastFailure = result;
  }

  return {
    ok: false,
    reason: 'no-trust-match',
    detail: lastFailure?.stderr || 'cosign rejected the binary against every trust root',
    identityChain,
  };
}

function invokeCosign({ cosignBin, bundlePath, binaryPath, identity }) {
  const args = [
    'verify-blob',
    '--bundle', bundlePath,
    '--certificate-identity-regexp', identity.identityRegexp,
    '--certificate-oidc-issuer', identity.issuer,
    binaryPath,
  ];
  const proc = spawnSync(cosignBin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.status === 0) {
    return { ok: true, stdout: proc.stdout || '' };
  }
  return {
    ok: false,
    exitCode: typeof proc.status === 'number' ? proc.status : -1,
    stderr: (proc.stderr || proc.stdout || '').trim().slice(0, 4096),
  };
}
