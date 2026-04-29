/**
 * pgserve fingerprint — kernel-rooted peer identity.
 *
 * On every accept on the daemon's control socket, the daemon needs to derive
 * a stable, 12-hex fingerprint that identifies the calling project. The chain:
 *
 *   1. SO_PEERCRED (Linux) / getpeereid + LOCAL_PEERPID (macOS)
 *      → kernel-attested {pid, uid, gid}
 *   2. /proc/$pid/cwd  → peer's current working directory (Linux only)
 *   3. walk upward to the nearest package.json
 *   4. if found:  fingerprint = sha256(realpath \0 name \0 uid)[:12]   mode='package'
 *      else:      fingerprint = sha256(uid \0 cwd \0 cmdline[1])[:12]  mode='script'
 *
 * Properties:
 *  - Identity is kernel-rooted: peer can't lie about uid/pid.
 *  - Stable across `cwd` changes inside the same project, across
 *    `npm install` (we hash realpath), and across runtime swaps
 *    (Bun ↔ Node — neither argv[0] nor exe path enters the input).
 *  - Monorepos: nearest-ancestor package.json wins (deepest match), matching
 *    the `require.resolve` mental model.
 *
 * Daemon integration (Group 2 wires this in):
 *   import { handleControlAccept, initFingerprintFfi } from './fingerprint.js';
 *   await initFingerprintFfi();          // once at daemon boot
 *   server.on('connection', (socket) => {
 *     const info = handleControlAccept(socket);   // also emits connection_routed
 *     // ... resolve DB by info.fingerprint, etc.
 *   });
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { audit, AUDIT_EVENTS } from './audit.js';

// ---------------------------------------------------------------------------
// Peer credentials: SO_PEERCRED (Linux) / getpeereid + LOCAL_PEERPID (macOS)
// ---------------------------------------------------------------------------

let _peerCredImpl = null;     // populated by initFingerprintFfi()
let _peerCredOverride = null; // test seam — see _setPeerCredImpl()

/**
 * Read kernel-attested peer credentials from a connected Unix socket.
 *
 * @param {import('net').Socket | number} socket
 * @returns {{pid: number, uid: number, gid: number}}
 */
export function getPeerCred(socket) {
  if (_peerCredOverride) return _peerCredOverride(socket);
  if (!_peerCredImpl) {
    throw new Error('getPeerCred: FFI not initialized — call await initFingerprintFfi() first');
  }
  const fd = extractFd(socket);
  if (fd == null || fd < 0) {
    throw new Error('getPeerCred: socket has no accessible file descriptor');
  }
  return _peerCredImpl(fd);
}

function extractFd(socket) {
  if (typeof socket === 'number') return socket;
  if (socket?._handle && typeof socket._handle.fd === 'number') return socket._handle.fd;
  if (typeof socket?.fd === 'number') return socket.fd;
  return null;
}

/**
 * Pre-warm the native FFI handle. Call once at daemon startup; tests call it
 * in their before-all hook. Safe to call repeatedly.
 *
 * Bypassed when a test override is installed via `_setPeerCredImpl`.
 *
 * @returns {Promise<void>}
 */
export async function initFingerprintFfi() {
  if (_peerCredOverride) return;
  if (_peerCredImpl) return;
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`initFingerprintFfi: unsupported platform "${process.platform}"`);
  }
  // bun:ffi loaded via dynamic import so plain-Node consumers can still
  // import the module surface without crashing on module-eval.
  const ffi = await import('bun:ffi');
  // glibc on Linux ships as libc.so.6 (versioned); macOS ships libc.dylib.
  const libcCandidates = process.platform === 'linux'
    ? ['libc.so.6', 'libc.so']
    : [`libc.${ffi.suffix}`];
  const lib = openFirst(ffi, libcCandidates, process.platform === 'linux'
    ? {
        getsockopt: {
          args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr],
          returns: ffi.FFIType.i32,
        },
      }
    : {
        getpeereid: {
          args: [ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr],
          returns: ffi.FFIType.i32,
        },
        getsockopt: {
          args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr],
          returns: ffi.FFIType.i32,
        },
      });
  _peerCredImpl = process.platform === 'linux'
    ? makeLinuxReader(lib.symbols, ffi.ptr)
    : makeDarwinReader(lib.symbols, ffi.ptr);
}

function openFirst(ffi, candidates, signatures) {
  let lastError;
  for (const name of candidates) {
    try {
      return ffi.dlopen(name, signatures);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `initFingerprintFfi: dlopen failed for [${candidates.join(', ')}]: ${lastError?.message ?? lastError}`,
  );
}

function makeLinuxReader(symbols, ptr) {
  // getsockopt(fd, SOL_SOCKET=1, SO_PEERCRED=17, &ucred, &len)
  // ucred = { pid: i32, uid: u32, gid: u32 } — 12 bytes packed.
  const SOL_SOCKET = 1;
  const SO_PEERCRED = 17;
  return (fd) => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    const len = new Uint32Array([12]);
    const rc = symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(buf), ptr(len));
    if (rc !== 0) {
      throw new Error(`getsockopt SO_PEERCRED failed (rc=${rc}, fd=${fd})`);
    }
    return {
      pid: view.getInt32(0, true),
      uid: view.getUint32(4, true),
      gid: view.getUint32(8, true),
    };
  };
}

function makeDarwinReader(symbols, ptr) {
  // macOS: getpeereid(fd, &uid, &gid) for credentials (no PID).
  // LOCAL_PEERPID via getsockopt(SOL_LOCAL=0, optname=2) supplies the pid
  // when the kernel has it; otherwise pid=0 (unknown but tolerated — the
  // fingerprint never depends on pid, only the GC liveness probe does).
  const SOL_LOCAL = 0;
  const LOCAL_PEERPID = 2;
  return (fd) => {
    const idBuf = new ArrayBuffer(8);
    const idView = new DataView(idBuf);
    const uidPtr = ptr(idBuf, 0);
    const gidPtr = ptr(idBuf, 4);
    const rc = symbols.getpeereid(fd, uidPtr, gidPtr);
    if (rc !== 0) {
      throw new Error(`getpeereid failed (rc=${rc}, fd=${fd})`);
    }
    const uid = idView.getUint32(0, true);
    const gid = idView.getUint32(4, true);
    let pid = 0;
    try {
      const pidBuf = new ArrayBuffer(4);
      const pidView = new DataView(pidBuf);
      const len = new Uint32Array([4]);
      if (symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(pidBuf), ptr(len)) === 0) {
        pid = pidView.getInt32(0, true);
      }
    } catch { /* LOCAL_PEERPID unsupported on this kernel */ }
    return { pid, uid, gid };
  };
}

// ---------------------------------------------------------------------------
// /proc reads — Linux-only; macOS daemon support is best-effort
// ---------------------------------------------------------------------------

/**
 * Resolve the cwd of a peer process via /proc/$pid/cwd. Linux-only.
 * Returns null if the symlink cannot be read (process gone, EACCES, etc).
 *
 * @param {number} pid
 * @returns {string | null}
 */
export function readProcCwd(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Read the peer's argv via /proc/$pid/cmdline (NUL-separated).
 * argv[0] is the exe; argv[1] is typically the script.
 *
 * @param {number} pid
 * @returns {string[]}
 */
export function readProcCmdline(pid) {
  if (process.platform !== 'linux') return [];
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!raw) return [];
    const trimmed = raw.endsWith('\0') ? raw.slice(0, -1) : raw;
    return trimmed.split('\0');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// package.json discovery
// ---------------------------------------------------------------------------

/**
 * Walk upward from `startCwd` to the filesystem root, returning the realpath
 * of the nearest ancestor `package.json`. Returns null if none found.
 *
 * Matches Node's `require.resolve` mental model: nested package.json wins
 * (deepest match). Monorepos that want the workspace root to win must opt
 * in via `pgserve.fingerprintRoot: "monorepo-root"` (deferred to v2.1).
 *
 * @param {string} startCwd
 * @returns {string | null} — absolute realpath to package.json, or null
 */
export function findNearestPackageJson(startCwd) {
  if (!startCwd) return null;
  let dir;
  try {
    dir = fs.realpathSync(startCwd);
  } catch {
    return null;
  }
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the `name` field from a package.json file. Returns null if absent,
 * malformed, or non-string.
 *
 * @param {string} packageJsonPath
 * @returns {string | null}
 */
export function readPackageName(packageJsonPath) {
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * Read the `pgserve.persist` flag from a package.json file. Returns false on
 * any error (missing file, malformed JSON, missing field) — the default
 * lifecycle is ephemeral; persist must be explicitly opted in.
 *
 * @param {string} packageJsonPath
 * @returns {boolean}
 */
export function readPersistFlag(packageJsonPath) {
  if (!packageJsonPath) return false;
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    return pkg?.pgserve?.persist === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fingerprint derivations
// ---------------------------------------------------------------------------

/**
 * `sha256(packageRealpath \0 name \0 uid)[:12]`
 *
 * NUL separators prevent collision-by-concatenation (e.g. project named
 * "abc 1000" can't impersonate uid=1000 / project=abc).
 *
 * @param {{packageRealpath: string, name: string, uid: number|string}} args
 * @returns {string} 12 lowercase hex chars
 */
export function derivePackageFingerprint({ packageRealpath, name, uid }) {
  if (!packageRealpath) throw new Error('derivePackageFingerprint: packageRealpath required');
  if (typeof name !== 'string') throw new Error('derivePackageFingerprint: name must be string');
  if (uid === undefined || uid === null) throw new Error('derivePackageFingerprint: uid required');
  const input = `${packageRealpath}\0${name}\0${String(uid)}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Script fallback: hashes uid + cwd + cmdline[1]. Used when no package.json
 * exists above the peer's cwd (e.g. a one-off `bun script.js` outside any
 * project root).
 *
 * @param {{uid: number|string, cwd: string, cmdline1: string}} args
 * @returns {string} 12 lowercase hex chars
 */
export function deriveScriptFingerprint({ uid, cwd, cmdline1 }) {
  if (uid === undefined || uid === null) throw new Error('deriveScriptFingerprint: uid required');
  if (!cwd) throw new Error('deriveScriptFingerprint: cwd required');
  const script = cmdline1 || '';
  const input = `${String(uid)}\0${cwd}\0${script}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Top-level resolver
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   fingerprint: string,
 *   packageRealpath: string | null,
 *   name: string | null,
 *   uid: number,
 *   pid: number,
 *   gid: number,
 *   mode: 'package' | 'script',
 *   cwd: string | null,
 * }} FingerprintInfo
 */

/**
 * End-to-end: read peer creds, resolve cwd via /proc, find package.json
 * (or fall back to script mode), produce the 12-hex fingerprint.
 *
 * @param {import('net').Socket | number} socket
 * @returns {FingerprintInfo}
 */
export function fingerprintForPeer(socket) {
  return fingerprintFromCred(getPeerCred(socket));
}

/**
 * Pure-input variant: bypass the FFI step. Used by daemon paths that
 * already have peer creds and by tests that don't want to spin up a real
 * Unix socket pair.
 *
 * @param {{pid: number, uid: number, gid: number}} cred
 * @param {{cwdOverride?: string, cmdlineOverride?: string[]}} [opts]
 * @returns {FingerprintInfo}
 */
export function fingerprintFromCred(cred, opts = {}) {
  if (!cred || typeof cred.uid !== 'number' || typeof cred.pid !== 'number') {
    throw new Error('fingerprintFromCred: cred must have numeric pid+uid');
  }
  const cwd = opts.cwdOverride !== undefined ? opts.cwdOverride : readProcCwd(cred.pid);
  const cmdline = opts.cmdlineOverride !== undefined ? opts.cmdlineOverride : readProcCmdline(cred.pid);

  const pkgPath = cwd ? findNearestPackageJson(cwd) : null;
  if (pkgPath) {
    const name = readPackageName(pkgPath) ?? '';
    const fingerprint = derivePackageFingerprint({
      packageRealpath: pkgPath,
      name,
      uid: cred.uid,
    });
    return {
      fingerprint,
      packageRealpath: pkgPath,
      name,
      uid: cred.uid,
      pid: cred.pid,
      gid: cred.gid,
      mode: 'package',
      cwd,
    };
  }

  const fingerprint = deriveScriptFingerprint({
    uid: cred.uid,
    cwd: cwd || '',
    cmdline1: cmdline[1] || '',
  });
  return {
    fingerprint,
    packageRealpath: null,
    name: null,
    uid: cred.uid,
    pid: cred.pid,
    gid: cred.gid,
    mode: 'script',
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Daemon accept hook
// ---------------------------------------------------------------------------

/**
 * Wrap `fingerprintForPeer` with a `connection_routed` audit emit.
 * The daemon (Group 2) calls this on every control-socket accept.
 *
 * @param {import('net').Socket | number} socket
 * @param {{cwdOverride?: string, cmdlineOverride?: string[], auditTarget?: 'file'|'syslog'}} [opts]
 * @returns {FingerprintInfo}
 */
export function handleControlAccept(socket, opts = {}) {
  const useOverrides = opts.cwdOverride !== undefined || opts.cmdlineOverride !== undefined;
  const info = useOverrides
    ? fingerprintFromCred(getPeerCred(socket), opts)
    : fingerprintForPeer(socket);
  audit(
    AUDIT_EVENTS.CONNECTION_ROUTED,
    {
      fingerprint: info.fingerprint,
      mode: info.mode,
      peer_pid: info.pid,
      peer_uid: info.uid,
      package_realpath: info.packageRealpath,
      name: info.name,
    },
    opts.auditTarget ? { target: opts.auditTarget } : {},
  );
  return info;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * Internal: tests can stub the peer-cred reader to avoid spinning up real
 * Unix socket pairs when they only care about the cwd/walk/hash logic.
 * Pass `null` to restore the default native reader.
 *
 * @param {((socket: any) => {pid:number, uid:number, gid:number}) | null} fn
 */
export function _setPeerCredImpl(fn) {
  _peerCredOverride = fn;
}

export const _internals = Object.freeze({
  extractFd,
  readProcCwd,
  readProcCmdline,
});
