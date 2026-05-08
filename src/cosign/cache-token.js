/**
 * HMAC-signed verification cache tokens.
 *
 * pgserve singleton (v2.4) — `pgserve-singleton-no-proxy` wish, Group 4.
 *
 * After `pgserve verify <binary>` succeeds we stash a token at
 *   `$XDG_STATE_HOME/pgserve/verified/<fingerprint>.token`
 * with mode 0600. Subsequent invocations short-circuit cosign when:
 *   - the token's HMAC matches (tamper-evident, keyed on cache.hmac),
 *   - the binary's mtime/size still match the cached values (re-verify
 *     when the binary changes on disk per SHARED-DESIGN.md §2.4),
 *   - the sliding-expiry window has not lapsed:
 *         idle  ≤ 1 hour since lastUsedAt
 *         total ≤ 7 days since createdAt.
 *
 * The HMAC key lives at `$XDG_STATE_HOME/pgserve/cache.hmac` (32 random
 * bytes, 0600). Auto-generated on first write; re-generated if the file
 * is missing or sized wrong (treated as cache-poisoning recovery).
 *
 * Tokens are stored as canonical JSON wrapped in an envelope:
 *   { v: 1, payload: <stable-stringify(token)>, mac: <hex hmac256> }
 * `payload` is a string (not a nested object) so we HMAC the exact bytes
 * we serialized. Nested objects would invite key-ordering ambiguity.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_VERSION = 1;
export const TOKEN_MODE = 0o600;
export const HMAC_KEY_BYTES = 32;
export const HMAC_KEY_MODE = 0o600;
export const TOKEN_DIR_MODE = 0o700;
export const SLIDING_IDLE_MS = 60 * 60 * 1000;             // 1 hour
export const SLIDING_MAX_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days

/**
 * Resolve `$XDG_STATE_HOME/pgserve` (preferred) or
 * `$HOME/.local/state/pgserve` (XDG default fallback). Mirrors the spec
 * referenced in the wish (`$XDG_STATE_HOME/pgserve/verified/...`).
 */
export function getStateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, 'pgserve');
  return path.join(os.homedir(), '.local', 'state', 'pgserve');
}

export function getVerifiedDir(stateDir = getStateDir()) {
  return path.join(stateDir, 'verified');
}

export function getHmacKeyPath(stateDir = getStateDir()) {
  return path.join(stateDir, 'cache.hmac');
}

export function getTokenPath(fingerprint, stateDir = getStateDir()) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('cache-token: fingerprint must be a non-empty string');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fingerprint)) {
    throw new TypeError(
      `cache-token: fingerprint contains unsafe characters: ${JSON.stringify(fingerprint)}`,
    );
  }
  return path.join(getVerifiedDir(stateDir), `${fingerprint}.token`);
}

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
}

/**
 * Read or create the HMAC key. The key is 32 random bytes stored at
 * mode 0600. Missing / wrong-sized files are recreated — treat poisoning
 * as a cache miss rather than a hard failure.
 */
export function ensureHmacKey({ stateDir = getStateDir() } = {}) {
  ensureDir(stateDir, TOKEN_DIR_MODE);
  const file = getHmacKeyPath(stateDir);
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length === HMAC_KEY_BYTES) return buf;
  }
  const buf = crypto.randomBytes(HMAC_KEY_BYTES);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, buf, { mode: HMAC_KEY_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, HMAC_KEY_MODE);
  return buf;
}

function stableStringify(obj) {
  // Deterministic JSON: sort keys at every level so the same logical
  // payload always produces the same bytes (and HMAC).
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',');
  return `{${body}}`;
}

function hmacHex(key, payloadString) {
  return crypto.createHmac('sha256', key).update(payloadString).digest('hex');
}

function timingSafeEqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Compute the binary attestation used as part of the cache key. Re-using
 * mtime + size catches the simple "operator updated the binary" case
 * cheaply; sha256 is intentionally NOT recomputed here on the cached path
 * (callers can recompute on demand if they want defense in depth).
 */
export function computeBinaryAttestation(binaryPath) {
  const stat = fs.statSync(binaryPath);
  if (!stat.isFile()) {
    throw new Error(`cache-token: binary path is not a file: ${binaryPath}`);
  }
  return {
    realpath: fs.realpathSync(binaryPath),
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
  };
}

/**
 * Build the canonical token payload. Caller supplies verification result;
 * we layer in createdAt / lastUsedAt timestamps and the binary attestation.
 */
export function buildTokenPayload({
  fingerprint,
  binary,
  identity,
  tier,
  sha256,
  now = Date.now(),
}) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    throw new TypeError('cache-token: fingerprint must be a non-empty string');
  }
  if (!binary || typeof binary !== 'object') {
    throw new TypeError('cache-token: binary attestation required');
  }
  if (typeof identity !== 'string' || identity.length === 0) {
    throw new TypeError('cache-token: identity must be a non-empty string');
  }
  if (typeof tier !== 'string' || tier.length === 0) {
    throw new TypeError('cache-token: tier must be a non-empty string');
  }
  return {
    v: TOKEN_VERSION,
    fingerprint,
    binary: {
      realpath: binary.realpath,
      size: binary.size,
      mtimeMs: binary.mtimeMs,
    },
    identity,
    tier,
    sha256: sha256 || null,
    createdAt: now,
    lastUsedAt: now,
  };
}

/**
 * Persist a verification token. Computes HMAC over the canonical payload
 * with the key from `ensureHmacKey()`. Atomic write via tmp+rename. mode
 * 0600.
 */
export function writeCacheToken(payload, { stateDir = getStateDir() } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('cache-token: payload must be an object');
  }
  if (payload.v !== TOKEN_VERSION) {
    throw new TypeError(`cache-token: unsupported token version ${payload.v}`);
  }
  const key = ensureHmacKey({ stateDir });
  ensureDir(getVerifiedDir(stateDir), TOKEN_DIR_MODE);

  const file = getTokenPath(payload.fingerprint, stateDir);
  const payloadString = stableStringify(payload);
  const envelope = {
    v: TOKEN_VERSION,
    payload: payloadString,
    mac: hmacHex(key, payloadString),
  };
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(envelope)}\n`, { mode: TOKEN_MODE });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, TOKEN_MODE);
  return file;
}

function classifyError(reason, detail) {
  return { ok: false, reason, ...(detail ? { detail } : {}) };
}

/**
 * Read + validate a cached token. Returns `{ ok: true, payload, file }`
 * on hit, `{ ok: false, reason }` on miss. Never throws on malformed
 * tokens — bad input is treated as a cache miss so the caller can fall
 * back to a fresh verify.
 */
export function readCacheToken(fingerprint, {
  binaryAttestation,
  stateDir = getStateDir(),
  now = Date.now(),
} = {}) {
  let file;
  try {
    file = getTokenPath(fingerprint, stateDir);
  } catch (err) {
    return classifyError('invalid-fingerprint', err.message);
  }
  if (!fs.existsSync(file)) {
    return classifyError('missing');
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return classifyError('unreadable', err.message);
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    return classifyError('malformed-envelope', err.message);
  }
  if (
    !envelope || typeof envelope !== 'object'
    || envelope.v !== TOKEN_VERSION
    || typeof envelope.payload !== 'string'
    || typeof envelope.mac !== 'string'
  ) {
    return classifyError('malformed-envelope');
  }

  const key = ensureHmacKey({ stateDir });
  const expected = hmacHex(key, envelope.payload);
  if (!timingSafeEqHex(expected, envelope.mac)) {
    return classifyError('hmac-mismatch');
  }

  let payload;
  try {
    payload = JSON.parse(envelope.payload);
  } catch (err) {
    return classifyError('malformed-payload', err.message);
  }
  if (!payload || payload.v !== TOKEN_VERSION) {
    return classifyError('malformed-payload');
  }
  if (payload.fingerprint !== fingerprint) {
    return classifyError('fingerprint-mismatch');
  }

  const createdAt = Number(payload.createdAt);
  const lastUsedAt = Number(payload.lastUsedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastUsedAt)) {
    return classifyError('malformed-timestamps');
  }
  if (now - createdAt > SLIDING_MAX_MS) {
    return classifyError('expired-max');
  }
  if (now - lastUsedAt > SLIDING_IDLE_MS) {
    return classifyError('expired-idle');
  }

  if (binaryAttestation) {
    const cached = payload.binary || {};
    if (
      cached.realpath !== binaryAttestation.realpath
      || cached.size !== binaryAttestation.size
      || cached.mtimeMs !== binaryAttestation.mtimeMs
    ) {
      return classifyError('binary-changed');
    }
  }

  return { ok: true, payload, file };
}

/**
 * Bump `lastUsedAt` to `now` on a hit. Returns the rewritten payload, or
 * `null` if the touch fails (treat as soft failure — the cached token is
 * still valid for this invocation).
 */
export function touchCacheToken(payload, { stateDir = getStateDir(), now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || payload.v !== TOKEN_VERSION) return null;
  const next = { ...payload, lastUsedAt: now };
  try {
    writeCacheToken(next, { stateDir });
    return next;
  } catch {
    return null;
  }
}

/**
 * Delete a cached token. Idempotent — missing file is a no-op.
 */
export function deleteCacheToken(fingerprint, { stateDir = getStateDir() } = {}) {
  let file;
  try {
    file = getTokenPath(fingerprint, stateDir);
  } catch {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
