// pgserve singleton (v2.4) — pm2 ecosystem (developer convenience).
//
// Production installs go through `pgserve install` (src/cli-install.cjs)
// which writes the canonical `autopg-server` entry pointing at the
// `pgserve postmaster` subcommand. This file exists for
// `pm2 start ecosystem.config.cjs` during local development of pgserve
// itself.
//
// `interpreter: 'none'` makes pm2 honor the `#!/usr/bin/env bun` shebang
// on `bin/postgres-server.js`, so `pm_exec_path` resolves to the
// postgres wrapper (not bun). This satisfies the singleton wish
// acceptance criterion that "pm2 entry's pm_exec_path points to postgres
// wrapper, NOT bun".

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'pgserve',
      script: './bin/postgres-server.js',
      args: 'postmaster --port 5432',
      cwd: __dirname,
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: path.join(__dirname, 'logs', 'pgserve-error.log'),
      out_file: path.join(__dirname, 'logs', 'pgserve-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true,
    },
  ],
};
