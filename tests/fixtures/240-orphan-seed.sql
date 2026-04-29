-- Group 5 — synthetic orphan fixture.
--
-- Seeds 240 rows in `pgserve_meta` with stale `last_connection_at`
-- (48 hours old, well past the 24h TTL) and a dead `liveness_pid`. Half
-- the rows use a guaranteed-out-of-range PID (2147483646, far above
-- Linux's pid_max ≤ 2^22 ≈ 4M); the other half use NULL so the sweep
-- exercises both audit code paths (`db_reaped_liveness` vs `db_reaped_ttl`).
--
-- The accompanying harness `tests/orphan-cleanup.test.js` runs this file
-- and then `CREATE DATABASE`s each row's `database_name` so the sweep
-- actually has something to DROP.

INSERT INTO pgserve_meta (
  database_name,
  fingerprint,
  peer_uid,
  package_realpath,
  last_connection_at,
  liveness_pid,
  persist
)
SELECT
  format('app_orphan_%s', lpad(to_hex(i), 12, '0')),
  lpad(to_hex(i), 12, '0'),
  1000,
  NULL,
  now() - interval '48 hours',
  CASE WHEN i % 2 = 0 THEN 2147483646 ELSE NULL END,
  false
FROM generate_series(1, 240) AS i;
