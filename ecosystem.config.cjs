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
        // 视频生成（spawn claude -p）所需：PM2 resurrect 时 nvm 不在 PATH，必须绝对路径
        HOME: process.env.HOME,
        CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH || `${process.env.HOME}/.nvm/versions/node/v22.22.2/bin/claude`,
        VIDEO_WORKSPACE_PATH: path.join(
          repoRoot,
          ".autopilot/runtime/requirements/20260725-每日视频生成/video-dryrun",
        ),
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
      args: "node_modules/.bin/next dev",
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
