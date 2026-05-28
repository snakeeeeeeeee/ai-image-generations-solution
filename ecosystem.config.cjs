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
      max_memory_restart: '768M',
      kill_timeout: 30000,
      wait_ready: false,
      time: true,
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true
    }
  ]
};
