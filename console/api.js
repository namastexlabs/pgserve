/* autopg console · API client.
 *
 * Wraps the four helper endpoints exposed by `autopg ui`:
 *   GET  /api/settings   →  { settings, sources, etag, path }
 *   PUT  /api/settings   →  { ok, etag } | { error: { code, message, field? } }
 *   POST /api/restart    →  { ok } | { error }
 *   GET  /api/status     →  whatever `pgserve status --json` returns
 *
 * The latest etag from a successful GET is cached on the module so PUTs can
 * send `If-Match` without the caller threading it through manually. PUT
 * replies update the cached etag too so successive saves chain cleanly.
 *
 * Errors from the server come back as `{ error: { code, message, field? } }`.
 * The wrapper raises a structured `ApiError` (with `.code`, `.field`,
 * `.message`, `.status`, `.currentEtag?`) so screens can branch on the code
 * without parsing strings. ETAG_MISMATCH is surfaced as a normal rejection
 * with `error.code === 'ETAG_MISMATCH'` plus `error.currentEtag` so the
 * Settings screen can show a "settings changed, reload?" banner.
 */
(function (root) {
  'use strict';

  const STATE = { etag: null };

  class ApiError extends Error {
    constructor({ code, message, field, status, currentEtag }) {
      super(message || code || 'api error');
      this.name = 'ApiError';
      this.code = code || 'UNKNOWN';
      if (field) this.field = field;
      if (typeof status === 'number') this.status = status;
      if (currentEtag) this.currentEtag = currentEtag;
    }
  }

  async function parseJson(res) {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  }

  async function getSettings() {
    const res = await fetch('/api/settings', {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const body = await parseJson(res);
    if (!res.ok) {
      throw new ApiError({
        code: body?.error?.code,
        message: body?.error?.message,
        field: body?.error?.field,
        status: res.status,
      });
    }
    if (body && body.etag) STATE.etag = body.etag;
    return body;
  }

  async function putSettings(patch, { ifMatch } = {}) {
    const etag = ifMatch ?? STATE.etag;
    if (!etag) {
      throw new ApiError({
        code: 'PRECONDITION_REQUIRED',
        message: 'no etag cached — call getSettings() before putSettings()',
        status: 428,
      });
    }
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-match': etag,
        accept: 'application/json',
      },
      body: JSON.stringify(patch ?? {}),
    });
    const body = await parseJson(res);
    if (res.status === 409) {
      // Update the cached etag so the next reload has the latest.
      if (body && body.currentEtag) STATE.etag = body.currentEtag;
      throw new ApiError({
        code: body?.error?.code || 'ETAG_MISMATCH',
        message: body?.error?.message || 'settings changed on disk',
        status: 409,
        currentEtag: body?.currentEtag,
      });
    }
    if (!res.ok) {
      throw new ApiError({
        code: body?.error?.code,
        message: body?.error?.message,
        field: body?.error?.field,
        status: res.status,
      });
    }
    if (body && body.etag) STATE.etag = body.etag;
    return body;
  }

  async function restart() {
    const res = await fetch('/api/restart', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    const body = await parseJson(res);
    if (!res.ok) {
      throw new ApiError({
        code: body?.error?.code,
        message: body?.error?.message,
        status: res.status,
      });
    }
    return body;
  }

  async function getStatus() {
    const res = await fetch('/api/status', {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const body = await parseJson(res);
    if (!res.ok) {
      throw new ApiError({
        code: body?.error?.code,
        message: body?.error?.message,
        status: res.status,
      });
    }
    return body;
  }

  // Live pgserve stats — connections + databases. Always returns a body
  // (status 200) even when the daemon is unreachable; check `body.ok`.
  // Safe to poll from the topbar without try/catch error handling.
  async function getStats() {
    try {
      const res = await fetch('/api/stats', {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      return await parseJson(res);
    } catch (err) {
      return { ok: false, reason: 'fetch-failed', message: err.message };
    }
  }

  function getCachedEtag() {
    return STATE.etag;
  }

  function setCachedEtag(etag) {
    STATE.etag = etag || null;
  }

  root.AutopgApi = {
    getSettings,
    putSettings,
    restart,
    getStatus,
    getStats,
    getCachedEtag,
    setCachedEtag,
    ApiError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
