module.exports = {
  apps: [
    {
      name: 'pgserve',
      script: './bin/postgres-server.js',
      args: 'router --port 8432',
      cwd: '/home/namastex/dev/pgserve',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/home/namastex/logs/postgres-server-error.log',
      out_file: '/home/namastex/logs/postgres-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      time: true
    }
  ]
};
