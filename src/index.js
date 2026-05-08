/**
 * pgserve — Embedded PostgreSQL Server (singleton, v2.4+)
 *
 * Public surface after the `pgserve-singleton-no-proxy` Group 2 deletion:
 * the bun proxy data plane, daemon control socket, libpq protocol
 * rewriting, and SO_PEERCRED handshake are gone. Operators interact with
 * pgserve through the CLI (`bin/pgserve-wrapper.cjs`), the postmaster
 * subcommand (`bin/postgres-server.js postmaster`), and the cohort-shared
 * helpers under `src/lib/`.
 *
 * `PostgresManager` is exported for tests and integrators that want to
 * embed a postgres instance programmatically — it is the same class the
 * postmaster subcommand instantiates.
 */

export { PostgresManager } from './postgres.js';
