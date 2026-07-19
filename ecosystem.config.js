module.exports = {
  apps: [
    {
      name: "payment-gateway",
      script: "dist/server.js",
      instances: "max", // Utilize clustering for multiple cores
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "1G", // Prevent memory leaks
      env: {
        NODE_ENV: "development",
      },
      env_production: {
        NODE_ENV: "production",
      },
      kill_timeout: 4000, // Allow 4 seconds for graceful shutdown handling
      listen_timeout: 3000,
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-access.log",
    },
  ],
};
