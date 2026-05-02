/**
 * autopg settings schema (version 1).
 *
 * Single source of truth shared by:
 *   - settings-loader.js  (defaults + env merge)
 *   - settings-validator.js (type / range / enum checks)
 *   - settings-writer.js  (validateAll on write)
 *   - cli-config.cjs      (list / get / set surface)
 *   - daemon (cluster.js, postgres.js)  (effective config consumer)
 *   - console UI          (form rendering)
 *
 * Schema model:
 *   - 6 sections: server, runtime, sync, supervision, postgres, ui.
 *   - Each leaf: { type, default, env?, range?, enum?, description? }.
 *   - `postgres._extra` is a free-form passthrough map: { [gucName]: scalar }
 *     validated dynamically against the GUC name regex + scalar value rules.
 *
 * `env` lists env var names checked in priority order (AUTOPG first, PGSERVE
 * second). Loader uses this list to compute precedence and source attribution.
 *
 * No frontmatter / version field on individual leaves — top-level SCHEMA_VERSION
 * tracks the schema shape itself.
 */

'use strict';

const SCHEMA_VERSION = 1;

/**
 * GUC name regex — lower-case ASCII identifier, no leading digit, no spaces.
 * Postgres GUC names are case-insensitive but conventionally written
 * lower-case; we enforce lower-case at the schema boundary so `_extra`
 * keys round-trip cleanly through `-c key=value`.
 */
const GUC_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

/**
 * Scalar value rule for postgres GUCs (curated and `_extra`):
 *   - must be string | number | boolean
 *   - if string: no \n, \r, \0
 *   - if string: no leading `-` (would look like a CLI flag to Bun.spawn array form)
 *
 * Defense-in-depth on top of Bun.spawn's array form (which avoids shell
 * interpretation entirely).
 */
const FORBIDDEN_VALUE_CHARS = /[\n\r\0]/;

const SCHEMA = {
  server: {
    port: {
      type: 'int',
      default: 8432,
      env: ['AUTOPG_PORT', 'PGSERVE_PORT'],
      range: [1, 65535],
      description: 'Router TCP port (clients connect here)',
    },
    host: {
      type: 'string',
      default: '127.0.0.1',
      env: ['AUTOPG_HOST', 'PGSERVE_HOST'],
      description: 'Bind address for the router',
    },
    pgPort: {
      type: 'int',
      default: 6432,
      env: ['AUTOPG_PG_PORT', 'PGSERVE_PG_PORT'],
      range: [1, 65535],
      description: 'Internal PostgreSQL backend port',
    },
    pgSocketPath: {
      type: 'string',
      default: '',
      env: ['AUTOPG_PG_SOCKET', 'PGSERVE_PG_SOCKET'],
      description: 'Unix socket path for backend (empty = TCP only)',
      nullable: true,
    },
    pgUser: {
      type: 'string',
      default: 'postgres',
      env: ['AUTOPG_PG_USER', 'PGSERVE_PG_USER'],
      description: 'Backend superuser',
    },
    pgPassword: {
      type: 'string',
      default: 'postgres',
      env: ['AUTOPG_PG_PASSWORD', 'PGSERVE_PG_PASSWORD'],
      secret: true,
      description: 'Backend superuser password (file is chmod 0600)',
    },
  },

  runtime: {
    logLevel: {
      type: 'enum',
      default: 'info',
      enum: ['debug', 'info', 'warn', 'error'],
      env: ['AUTOPG_LOG_LEVEL', 'PGSERVE_LOG_LEVEL', 'LOG_LEVEL'],
      description: 'Log verbosity',
    },
    autoProvision: {
      type: 'bool',
      default: true,
      env: ['AUTOPG_AUTO_PROVISION', 'PGSERVE_AUTO_PROVISION'],
      description: 'Auto-create missing databases on first connect',
    },
    enablePgvector: {
      type: 'bool',
      default: false,
      env: ['AUTOPG_ENABLE_PGVECTOR', 'PGSERVE_ENABLE_PGVECTOR'],
      description: 'Load pgvector extension on database create',
    },
    dataDir: {
      type: 'string',
      default: '',
      env: ['AUTOPG_DATA_DIR', 'PGSERVE_DATA_DIR'],
      description: 'PG cluster data directory (empty = <configDir>/data)',
      nullable: true,
    },
    cluster: {
      type: 'enum',
      default: 'auto',
      enum: ['auto', 'on', 'off'],
      env: ['AUTOPG_CLUSTER', 'PGSERVE_CLUSTER'],
      description: 'Cluster mode (auto = on for multi-core hosts)',
    },
    workers: {
      type: 'int',
      default: 0,
      range: [0, 256],
      env: ['AUTOPG_WORKERS', 'PGSERVE_WORKERS'],
      description: 'Worker processes (0 = CPU cores)',
    },
    ramMode: {
      type: 'bool',
      default: false,
      env: ['AUTOPG_RAM', 'PGSERVE_RAM'],
      description: 'Use /dev/shm storage (Linux only, ~2x faster)',
    },
    statsDashboard: {
      type: 'bool',
      default: true,
      env: ['AUTOPG_STATS', 'PGSERVE_STATS'],
      description: 'Show TTY stats dashboard when running in foreground',
    },
  },

  sync: {
    enabled: {
      type: 'bool',
      default: false,
      env: ['AUTOPG_SYNC_ENABLED', 'PGSERVE_SYNC_ENABLED'],
      description: 'Enable WAL-based logical replication',
    },
    url: {
      type: 'string',
      default: '',
      env: ['AUTOPG_SYNC_TO', 'PGSERVE_SYNC_TO'],
      description: 'Upstream PostgreSQL URL for replication (--sync-to)',
      secret: true,
      nullable: true,
    },
    databases: {
      type: 'string',
      default: '*',
      env: ['AUTOPG_SYNC_DATABASES', 'PGSERVE_SYNC_DATABASES'],
      description: 'Database glob patterns to sync, comma-separated (--sync-databases)',
    },
  },

  supervision: {
    maxMemory: {
      type: 'string',
      default: '4G',
      env: ['AUTOPG_MAX_MEMORY', 'PGSERVE_MAX_MEMORY'],
      description: 'pm2 memory ceiling (e.g. 4G, 8G)',
    },
    maxRestarts: {
      type: 'int',
      default: 50,
      env: ['AUTOPG_MAX_RESTARTS', 'PGSERVE_MAX_RESTARTS'],
      range: [1, 1000],
      description: 'pm2 max rapid restarts before giving up',
    },
    minUptimeMs: {
      type: 'int',
      default: 10000,
      env: ['AUTOPG_MIN_UPTIME_MS', 'PGSERVE_MIN_UPTIME_MS'],
      range: [0, 600000],
      description: 'pm2 min uptime to count as a healthy start',
    },
    restartDelayMs: {
      type: 'int',
      default: 4000,
      range: [0, 600000],
      env: ['AUTOPG_RESTART_DELAY_MS', 'PGSERVE_RESTART_DELAY_MS'],
      description: 'pm2 fixed delay before each restart',
    },
    expBackoffRestartDelayMs: {
      type: 'int',
      default: 100,
      range: [0, 600000],
      env: ['AUTOPG_EXP_BACKOFF_DELAY_MS', 'PGSERVE_EXP_BACKOFF_DELAY_MS'],
      description: 'pm2 initial exponential-backoff delay',
    },
    expBackoffMaxMs: {
      type: 'int',
      default: 60000,
      range: [1000, 600000],
      env: ['AUTOPG_EXP_BACKOFF_MAX_MS', 'PGSERVE_EXP_BACKOFF_MAX_MS'],
      description: 'pm2 exponential-backoff ceiling (ramp cap ~60s)',
    },
    killTimeoutMs: {
      type: 'int',
      default: 60000,
      env: ['AUTOPG_KILL_TIMEOUT_MS', 'PGSERVE_KILL_TIMEOUT_MS'],
      range: [1000, 600000],
      description: 'Graceful shutdown window before SIGKILL',
    },
    logDateFormat: {
      type: 'string',
      default: 'YYYY-MM-DD HH:mm:ss.SSS',
      env: ['AUTOPG_LOG_DATE_FORMAT', 'PGSERVE_LOG_DATE_FORMAT'],
      description: 'pm2 log timestamp format string',
    },
  },

  security: {
    handshakeDeadlineMs: {
      type: 'int',
      default: 5000,
      range: [100, 60000],
      env: ['AUTOPG_HANDSHAKE_DEADLINE_MS', 'PGSERVE_HANDSHAKE_DEADLINE_MS'],
      description: 'Control-socket peer handshake deadline before forced close',
    },
  },

  audit: {
    target: {
      type: 'string',
      default: '',
      env: ['AUTOPG_AUDIT_TARGET', 'PGSERVE_AUDIT_TARGET'],
      description: 'Audit event destination (JSONL file path or HTTP endpoint)',
      nullable: true,
    },
  },

  postgres: {
    // Curated set: 14 commonly-tuned GUCs + the WAL replication block.
    // Hardcoded values previously in postgres.js (`max_connections=1000` and the
    // sync-conditional WAL block) are promoted here as defaults.
    max_connections: {
      type: 'int',
      default: 1000,
      range: [1, 262143],
      guc: true,
      description: 'Maximum concurrent connections',
    },
    shared_buffers: {
      type: 'string',
      default: '128MB',
      guc: true,
      description: 'Shared memory buffer pool',
    },
    work_mem: {
      type: 'string',
      default: '4MB',
      guc: true,
      description: 'Per-operation work memory',
    },
    maintenance_work_mem: {
      type: 'string',
      default: '64MB',
      guc: true,
      description: 'Memory for VACUUM / CREATE INDEX',
    },
    effective_cache_size: {
      type: 'string',
      default: '4GB',
      guc: true,
      description: 'Planner estimate of OS cache',
    },
    wal_level: {
      type: 'enum',
      default: 'logical',
      enum: ['minimal', 'replica', 'logical'],
      guc: true,
      description: 'WAL detail level (logical = replication-ready)',
    },
    max_replication_slots: {
      type: 'int',
      default: 10,
      range: [0, 1000],
      guc: true,
      description: 'Max replication slots',
    },
    max_wal_senders: {
      type: 'int',
      default: 10,
      range: [0, 1000],
      guc: true,
      description: 'Max WAL sender processes',
    },
    wal_keep_size: {
      type: 'string',
      default: '512MB',
      guc: true,
      description: 'WAL retention for replicas to catch up',
    },
    log_statement: {
      type: 'enum',
      default: 'none',
      enum: ['none', 'ddl', 'mod', 'all'],
      guc: true,
      description: 'SQL statement logging level',
    },
    log_min_duration_statement: {
      type: 'int',
      default: -1,
      range: [-1, 2147483647],
      guc: true,
      description: 'Slow query threshold (ms, -1 = off)',
    },
    statement_timeout: {
      type: 'int',
      default: 0,
      range: [0, 2147483647],
      guc: true,
      description: 'Statement timeout (ms, 0 = none)',
    },
    idle_in_transaction_session_timeout: {
      type: 'int',
      default: 0,
      range: [0, 2147483647],
      guc: true,
      description: 'Idle-in-transaction timeout (ms, 0 = none)',
    },
    autovacuum: {
      type: 'bool',
      default: true,
      guc: true,
      description: 'Enable autovacuum daemon',
    },
    // Free-form passthrough for additional GUCs not curated above.
    // Validated dynamically against GUC_NAME_REGEX + scalar value rules.
    _extra: {
      type: 'guc_map',
      default: {},
      description: 'Raw passthrough GUC map (key=value applied as -c flags)',
    },
  },

  ui: {
    theme: {
      type: 'enum',
      default: 'mdr',
      enum: ['mdr', 'lumon'],
      description: 'Console theme',
    },
    phosphor: {
      type: 'enum',
      default: 'amber',
      enum: ['amber', 'green', 'white'],
      description: 'CRT phosphor color',
    },
    density: {
      type: 'enum',
      default: 'comfortable',
      enum: ['compact', 'comfortable', 'spacious'],
      description: 'Layout density',
    },
    crt: {
      type: 'bool',
      default: true,
      description: 'CRT scanline effect',
    },
  },
};

/**
 * Build a map of every leaf key (dotted path) to its descriptor.
 * Nested example: `server.port` -> { type: 'int', default: 8432, ... }.
 * `postgres._extra` is treated as a leaf (its descriptor is the guc_map type).
 */
function flattenSchema(schema = SCHEMA) {
  const out = {};
  for (const [section, fields] of Object.entries(schema)) {
    for (const [key, descriptor] of Object.entries(fields)) {
      out[`${section}.${key}`] = descriptor;
    }
  }
  return out;
}

/**
 * Default settings tree — useful as a baseline for the loader and as the
 * seed for `autopg config init`.
 */
function buildDefaults(schema = SCHEMA) {
  const out = {};
  for (const [section, fields] of Object.entries(schema)) {
    out[section] = {};
    for (const [key, descriptor] of Object.entries(fields)) {
      // Clone defaults so callers can't mutate the schema's reference.
      const def = descriptor.default;
      if (def && typeof def === 'object') {
        out[section][key] = Array.isArray(def) ? [...def] : { ...def };
      } else {
        out[section][key] = def;
      }
    }
  }
  return out;
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  GUC_NAME_REGEX,
  FORBIDDEN_VALUE_CHARS,
  flattenSchema,
  buildDefaults,
};
