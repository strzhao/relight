const path = require("node:path");

// 用 __dirname 确保 PM2 从任意目录执行时 cwd 都能正确指向 monorepo 子包
const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "relight-workers",
      cwd: path.join(repoRoot, "apps/backend"),
      script: "src/workers/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_memory_restart: "2G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "development",
        REPO_ROOT: repoRoot,
        PATH: process.env.PATH,
      },
    },
    {
      name: "relight-api",
      cwd: path.join(repoRoot, "apps/backend"),
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "development",
        REPO_ROOT: repoRoot,
        PATH: process.env.PATH, // boot resurrect 时 API spawn 的 pnpm 需 PATH 解析
      },
    },
    {
      name: "relight-web",
      cwd: path.join(repoRoot, "apps/web"),
      script: "scripts/run-with-env.mjs",
      args: "node_modules/.bin/next dev --turbopack",
      interpreter: "node",
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "development",
        PATH: process.env.PATH,
      },
    },
  ],
};
