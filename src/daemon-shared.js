/**
 * Shared helpers for the Unix-socket and TCP accept paths.
 *
 * Kept as a tiny module so daemon.js stays under 1000 lines (AGENTS.md §8)
 * without forcing a circular dep between daemon-control.js and daemon-tcp.js.
 */

/**
 * Drain the buffered tail to a Bun socket. Returns the still-pending tail
 * (or null when fully flushed). Same shape as the original inline helper
 * in daemon.js.
 */
export function flushPending(target, pending) {
  const written = target.write(pending);
  if (written === pending.byteLength) return null;
  if (written === 0) return pending;
  return pending.subarray(written);
}
