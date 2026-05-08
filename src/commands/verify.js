/**
 * `pgserve verify <binary-path>` — cosign-keyless-OIDC verification.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * Flow:
 *   1. Resolve target binary, compute realpath + sha256 + size + mtime.
 *   2. Look up the HMAC-signed cache at `$XDG_STATE_HOME/pgserve/verified/
 *      <fingerprint>.token`. If valid (HMAC matches, sliding expiry not
 *      lapsed, binary attestation matches mtime/size) → short-circuit.
 *   3. Otherwise call `verifyBinary()` (cosign verify-blob against the
 *      hardcoded trust list per `src/cosign/trust-list.js`).
 *   4. On success: persist the cache token (mode 0600). On failure: emit
 *      a diagnostic and exit non-zero.
 *
 * Flags:
 *   --json                 — emit machine-readable result on stdout
 *   --skip-sigstore        — bypass cosign and consult the operator's
 *                            offline trust file. Refuses unless the file
 *                            records at least one offline-cosign-key entry
 *                            (managed by G3's `pgserve trust add`).
 *   --bundle <path>        — override the sigstore bundle sidecar path
 *   --cosign-bin <path>    — override the cosign executable
 *   --allow-fetch          — let cosign be fetched if missing on PATH
 *   --no-cache             — never read or write the verified-cache token
 *
 * Exit codes:
 *   0  — verified (fresh or cache hit)
 *   2  — verification failed (cosign rejected, tampered binary, ...)
 *   3  — invocation problem (--skip-sigstore without pretrusted key,
 *         missing binary, missing bundle, no cosign on PATH, ...)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildTokenPayload,
  computeBinaryAttestation,
  deleteCacheToken,
  getStateDir,
  readCacheToken,
  touchCacheToken,
  writeCacheToken,
} from '../cosign/cache-token.js';
import { sha256File, verifyBinary } from '../cosign/verify-binary.js';

const EXIT_OK = 0;
const EXIT_VERIFY_FAILED = 2;
const EXIT_INVOCATION = 3;

/**
 * Compute the cache fingerprint for a binary. We use the realpath +
 * sha256 first 32 chars so two distinct binaries get distinct cache
 * entries even if they share a directory layout, while keeping the
 * filename short enough to be readable in `ls`.
 */
export function computeFingerprint(binaryRealpath, sha256) {
  return `${path.basename(binaryRealpath).replace(/[^A-Za-z0-9._-]/g, '_')}.${sha256.slice(0, 16)}`;
}

function getTrustFilePath() {
  if (process.env.PGSERVE_TRUST_FILE) return process.env.PGSERVE_TRUST_FILE;
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.pgserve', 'trust', 'identities.json');
}

/**
 * Load the operator-managed offline trust file. G3's `pgserve trust add
 * --offline-cosign-key` writes to this path; in G4 we only consume it.
 *
 * Expected shape:
 *   {
 *     offlineKeys: [
 *       { id: '<short-id>', publisher: '<package>', keyFingerprint: '...',
 *         addedAt: '<ISO>' },
 *       ...
 *     ]
 *   }
 */
function readOfflineTrust() {
  const file = getTrustFilePath();
  if (!fs.existsSync(file)) return { ok: false, reason: 'trust-file-missing', file };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'trust-file-unreadable', detail: err.message, file };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'trust-file-malformed', detail: err.message, file };
  }
  const keys = Array.isArray(doc?.offlineKeys) ? doc.offlineKeys : null;
  if (!keys || keys.length === 0) {
    return { ok: false, reason: 'no-offline-keys', file };
  }
  return { ok: true, keys, file };
}

function parseArgs(args) {
  const opts = {
    binaryPath: null,
    json: false,
    skipSigstore: false,
    bundlePath: null,
    cosignBin: null,
    allowFetch: false,
    noCache: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--skip-sigstore') opts.skipSigstore = true;
    else if (a === '--allow-fetch') opts.allowFetch = true;
    else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--bundle') opts.bundlePath = args[++i];
    else if (a === '--cosign-bin') opts.cosignBin = args[++i];
    else if (a === '--help' || a === '-h') {
      printHelp(process.stdout);
      return { exit: EXIT_OK };
    } else if (a.startsWith('-')) {
      process.stderr.write(`pgserve verify: unknown option ${JSON.stringify(a)}\n`);
      return { exit: EXIT_INVOCATION };
    } else if (opts.binaryPath === null) {
      opts.binaryPath = a;
    } else {
      process.stderr.write(`pgserve verify: unexpected positional argument ${JSON.stringify(a)}\n`);
      return { exit: EXIT_INVOCATION };
    }
  }
  if (!opts.binaryPath) {
    printHelp(process.stderr);
    return { exit: EXIT_INVOCATION };
  }
  return { opts };
}

function printHelp(stream) {
  stream.write(`pgserve verify <binary-path> [options]

Verify a binary against the cosign keyless OIDC trust list. On success,
persists an HMAC-signed cache token so subsequent invocations short-circuit
the cosign call until the binary changes (mtime/size) or the sliding
expiry lapses (1h idle / 7d max).

Options:
  --json                 Emit a machine-readable JSON result on stdout
  --skip-sigstore        Bypass cosign — requires \`pgserve trust add\` (G3)
  --bundle <path>        Override the sigstore bundle sidecar path
                         (default: <binary>.bundle)
  --cosign-bin <path>    Override the cosign executable
  --allow-fetch          Allow downloading cosign if missing
  --no-cache             Never read or write the verified-cache token
  --help, -h             Show this help

Exit codes:
  0  Verified (fresh or cache hit)
  2  Verification failed
  3  Invocation problem (missing binary/bundle/cosign/pretrusted key)
`);
}

function emit({ json }, payload) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (payload.ok) {
    const tag = payload.cached ? 'cached' : 'verified';
    process.stdout.write(`pgserve verify: ${tag} ${payload.binary} as ${payload.identity} (${payload.tier})\n`);
    if (payload.cached === false) {
      process.stdout.write(`pgserve verify: cache token written → ${payload.cacheFile}\n`);
    }
    return;
  }
  process.stderr.write(`pgserve verify: FAILED — ${payload.reason}${payload.detail ? `: ${payload.detail}` : ''}\n`);
  if (payload.identityChain && payload.identityChain.length > 0) {
    process.stderr.write(`pgserve verify: trust roots tried: ${JSON.stringify(payload.identityChain)}\n`);
  }
}

/**
 * Run the verify command. `argv` is the bare argument list AFTER the
 * `verify` token. Returns an integer exit code.
 */
export function runVerify(argv) {
  const parsed = parseArgs(argv);
  if (parsed.exit !== undefined) return parsed.exit;
  const opts = parsed.opts;

  const binaryPath = path.resolve(opts.binaryPath);
  if (!fs.existsSync(binaryPath)) {
    emit(opts, { ok: false, reason: 'binary-missing', detail: binaryPath });
    return EXIT_INVOCATION;
  }

  let attestation;
  try {
    attestation = computeBinaryAttestation(binaryPath);
  } catch (err) {
    emit(opts, { ok: false, reason: 'binary-attestation-failed', detail: err.message });
    return EXIT_INVOCATION;
  }
  const sha256 = sha256File(binaryPath);
  const fingerprint = computeFingerprint(attestation.realpath, sha256);

  // ── Cache lookup ─────────────────────────────────────────────────────
  if (!opts.noCache) {
    const cache = readCacheToken(fingerprint, { binaryAttestation: attestation });
    if (cache.ok) {
      // PR #79 P1 security fix: honor the requested tier strictly. Without
      // this gate, a token written under `--skip-sigstore` (tier:self_signed)
      // would be accepted on a subsequent run WITHOUT `--skip-sigstore`,
      // letting the operator bypass cosign verification entirely. The fix:
      // - default invocation (no --skip-sigstore) requires tier:cosign_signed
      // - --skip-sigstore invocation requires tier:self_signed
      // Mismatched-tier cache hits are treated as cache misses (fall through
      // to re-verify under the requested tier).
      const cachedTier = cache.payload.tier;
      const expectedTier = opts.skipSigstore ? 'self_signed' : 'cosign_signed';
      if (cachedTier === expectedTier) {
        // Tier matches — bump lastUsedAt and return.
        touchCacheToken(cache.payload, {});
        emit(opts, {
          ok: true,
          cached: true,
          binary: binaryPath,
          identity: cache.payload.identity,
          tier: cachedTier,
          sha256: cache.payload.sha256 || sha256,
          cacheFile: cache.file,
        });
        return EXIT_OK;
      }
      // Tier mismatch — fall through. Do NOT delete the cache token: the
      // existing token is valid for its own tier; we just need a fresh
      // verification under the currently-requested tier.
    }
    // Stale binary attestation invalidates the cache so the new fingerprint
    // wins. We delete defensively when the binary changed under us.
    if (cache.reason === 'binary-changed') {
      deleteCacheToken(fingerprint, {});
    }
  }

  // ── --skip-sigstore path ─────────────────────────────────────────────
  if (opts.skipSigstore) {
    const trust = readOfflineTrust();
    if (!trust.ok) {
      emit(opts, {
        ok: false,
        reason: 'skip-sigstore-without-pretrusted-key',
        detail:
          `--skip-sigstore requires an offline trust entry. None found (${trust.reason}). `
          + 'Operators must run `pgserve trust add --offline-cosign-key '
          + '<key-file> --identity <id>` once Group 3 of the singleton wish ships. '
          + `Trust file path: ${trust.file}`,
      });
      return EXIT_INVOCATION;
    }
    // Operator vouched for the binary via an offline-cosign-key entry; we
    // record it as `self_signed` tier (NOT cosign_signed — this is a less
    // strong attestation than a Sigstore OIDC chain).
    const identity = trust.keys[0].id;
    const payload = buildTokenPayload({
      fingerprint,
      binary: attestation,
      identity,
      tier: 'self_signed',
      sha256,
    });
    let cacheFile = null;
    if (!opts.noCache) {
      try {
        cacheFile = writeCacheToken(payload, {});
      } catch (err) {
        emit(opts, { ok: false, reason: 'cache-write-failed', detail: err.message });
        return EXIT_VERIFY_FAILED;
      }
    }
    emit(opts, {
      ok: true,
      cached: false,
      binary: binaryPath,
      identity,
      tier: 'self_signed',
      sha256,
      cacheFile,
      skipSigstore: true,
    });
    return EXIT_OK;
  }

  // ── Cosign path ──────────────────────────────────────────────────────
  const result = verifyBinary(binaryPath, {
    cosignBin: opts.cosignBin || process.env.PGSERVE_COSIGN_BIN || undefined,
    bundlePath: opts.bundlePath || undefined,
    allowFetch: opts.allowFetch === true,
  });

  if (!result.ok) {
    emit(opts, {
      ok: false,
      reason: result.reason,
      detail: result.detail,
      identityChain: result.identityChain,
    });
    if (result.reason === 'binary-missing'
        || result.reason === 'binary-unreadable'
        || result.reason === 'binary-not-a-file'
        || result.reason === 'bundle-missing'
        || result.reason === 'cosign-missing'
        || result.reason === 'empty-trust-list'
        || result.reason === 'invalid-args') {
      return EXIT_INVOCATION;
    }
    return EXIT_VERIFY_FAILED;
  }

  let cacheFile = null;
  if (!opts.noCache) {
    try {
      const payload = buildTokenPayload({
        fingerprint,
        binary: attestation,
        identity: result.identity,
        tier: result.tier,
        sha256: result.sha256,
      });
      cacheFile = writeCacheToken(payload, {});
    } catch (err) {
      emit(opts, { ok: false, reason: 'cache-write-failed', detail: err.message });
      return EXIT_VERIFY_FAILED;
    }
  }
  emit(opts, {
    ok: true,
    cached: false,
    binary: binaryPath,
    identity: result.identity,
    publisher: result.publisher,
    tier: result.tier,
    sha256: result.sha256,
    cacheFile,
    bundle: result.bundle,
    cosignBin: result.cosignBin,
  });
  return EXIT_OK;
}

// Convenience export so tests can introspect paths without re-implementing.
export const _internals = {
  computeFingerprint,
  getStateDir,
  getTrustFilePath,
};
