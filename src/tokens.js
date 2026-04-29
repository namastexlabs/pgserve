/**
 * pgserve TCP bearer-token helpers (Group 6).
 *
 * Tokens are random 256-bit secrets shown to the operator exactly once
 * (the output of `pgserve daemon issue-token`). Only their sha256 hash
 * is persisted in `pgserve_meta.allowed_tokens`. Verification therefore
 * compares hashes, never cleartext.
 *
 * Token id: short hex prefix used for revocation by humans
 * (`pgserve daemon revoke-token <id>`). It is also persisted alongside
 * the hash so `tcp_token_used` audit events can name which credential
 * authorised the connection without leaking the secret.
 *
 * Wire format on the TCP path: peers pass an `application_name` shaped
 * `?fingerprint=<12hex>&token=<bearer>` (a leading `?` is tolerated so
 * libpq URL-style strings round-trip cleanly). Both keys are required;
 * any missing or extra-long value is treated as auth-fail by the
 * daemon's accept hook, never bubbling further.
 */

import crypto from 'crypto';

const TOKEN_BYTES = 32;       // 256 bits — plenty of entropy
const TOKEN_ID_BYTES = 6;     // 12 hex chars — collision-bound at ~10^14
const MAX_TOKEN_LEN = 256;    // sanity guard for parse path
const FP_RE = /^[0-9a-f]{12}$/;

/**
 * Mint a fresh `(id, cleartext, hash)` triple. The cleartext is meant to
 * leave this process exactly once (printed to stdout by `issue-token`);
 * only the hash gets stored.
 *
 * @returns {{id: string, cleartext: string, hash: string}}
 */
export function mintToken() {
  const id = crypto.randomBytes(TOKEN_ID_BYTES).toString('hex');
  const cleartext = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const hash = hashToken(cleartext);
  return { id, cleartext, hash };
}

/**
 * Sha256 of the bearer token in lowercase hex. Centralised so daemon
 * accept code, issue-token CLI, and tests cannot drift.
 *
 * @param {string} cleartext
 * @returns {string}
 */
export function hashToken(cleartext) {
  if (typeof cleartext !== 'string' || cleartext.length === 0) {
    throw new Error('hashToken: non-empty string required');
  }
  return crypto.createHash('sha256').update(cleartext).digest('hex');
}

/**
 * Parse `?fingerprint=<12hex>&token=<bearer>` — or its prefix-less form —
 * out of an `application_name` startup parameter.
 *
 * Returns `null` for any malformed input. Caller never inspects details
 * beyond presence: the daemon emits a single `tcp_token_denied` audit
 * event regardless of which validation step failed, to deny the peer
 * any oracle that distinguishes "unknown fingerprint" from "wrong token".
 *
 * @param {string|undefined|null} applicationName
 * @returns {{fingerprint: string, token: string} | null}
 */
export function parseTcpAuth(applicationName) {
  if (typeof applicationName !== 'string' || applicationName.length === 0) return null;
  if (applicationName.length > MAX_TOKEN_LEN + 64) return null;
  const stripped = applicationName.startsWith('?') ? applicationName.slice(1) : applicationName;
  const params = new Map();
  for (const segment of stripped.split('&')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq);
    const val = segment.slice(eq + 1);
    if (key && val) params.set(key, val);
  }
  const fingerprint = params.get('fingerprint');
  const token = params.get('token');
  if (!fingerprint || !token) return null;
  if (!FP_RE.test(fingerprint)) return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  return { fingerprint, token };
}

/**
 * Constant-time string compare. Bearer-token verification path uses this
 * after sha256 to avoid leaking length-mismatch via timing.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}
