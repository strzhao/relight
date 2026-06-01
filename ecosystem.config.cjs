module.exports = {
  apps: [
    {
      name: "relight-workers",
      cwd: "./apps/backend",
      script: "src/workers/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_memory_restart: "2G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "development",
        REPO_ROOT: process.cwd(),
        PATH: process.env.PATH,
      },
    },
    {
      name: "relight-api",
      cwd: "./apps/backend",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "development",
        REPO_ROOT: process.cwd(),
        PATH: process.env.PATH, // boot resurrect 时 API spawn 的 pnpm 需 PATH 解析
      },
    },
  ],
};
