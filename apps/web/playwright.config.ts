import { defineConfig } from "@playwright/test";

// worktree 中 web 端口由 .env.local 决定（PORT 字段，pnpm worktree:setup 自动写入）
// 主仓库默认 3001；env 覆盖让 e2e 测试在 worktree 中也能运行
const PORT = Number(process.env.E2E_PORT ?? process.env.PORT ?? 3001);

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm dev",
    port: PORT,
    reuseExistingServer: true,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
});
