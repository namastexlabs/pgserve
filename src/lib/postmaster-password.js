/**
 * Managed superuser password resolution for the postmaster entry.
 *
 * PostgresManager has always accepted `options.password` — it flows into
 * initdb's `--pwfile` (fresh clusters) and the TCP admin pool — but the
 * `postmaster` subcommand never wired it, silently pinning the built-in
 * 'postgres' default. Supervisors that rotate the superuser password (the
 * k8s Helm chart's provision Job, for example) then crash-loop the
 * postmaster on every restart: the admin pool re-authenticates fresh at
 * each boot and is refused (observed in the omni k8s node-restart
 * incident, 2026-07-03).
 *
 * Resolution order mirrors settings-schema.cjs `server.pgPassword`:
 *   AUTOPG_PG_PASSWORD > PGSERVE_PG_PASSWORD (legacy) > 'postgres'.
 *
 * Env is the right channel for supervised deployments (k8s secretKeyRef,
 * pm2 env files) — settings.json is non-secret and stays password-free.
 * Empty strings are treated as unset so `AUTOPG_PG_PASSWORD=` in a unit
 * file cannot lock the pool out with a blank password.
 */

export const POSTMASTER_PASSWORD_ENV_VARS = ['AUTOPG_PG_PASSWORD', 'PGSERVE_PG_PASSWORD'];

export const DEFAULT_POSTMASTER_PASSWORD = 'postgres';

/**
 * Resolve the superuser password the postmaster should hand to
 * PostgresManager. Returns `{ password, source }` where `source` is the
 * env var name that supplied it, or `'default'` — callers may log the
 * SOURCE for operability, never the value.
 */
export function resolvePostmasterPassword(env = process.env) {
  for (const name of POSTMASTER_PASSWORD_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return { password: value, source: name };
    }
  }
  return { password: DEFAULT_POSTMASTER_PASSWORD, source: 'default' };
}
