module.exports = {
  apps: [
    {
      name: "relight-workers",
      cwd: "./apps/backend",
      script: "src/workers/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      env: { NODE_ENV: "development" },
    },
  ],
};
