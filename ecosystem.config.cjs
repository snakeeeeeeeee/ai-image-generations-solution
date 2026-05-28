module.exports = {
  apps: [
    {
      name: 'image-handle',
      script: 'dist/src/index.js',
      exec_mode: 'fork',
      instances: 1,
      cwd: __dirname,
      env: {
        NODE_ENV: 'production'
      },
      node_args: [
        `--max-old-space-size=${process.env.NODE_MAX_OLD_SPACE_SIZE_MB || '24576'}`
      ],
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '30G',
      kill_timeout: 30000,
      wait_ready: false,
      time: true,
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true
    }
  ]
};
