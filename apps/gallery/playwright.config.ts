import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 拾光画廊 Playwright 配置（红队 acceptance + QA Tier 1.5 谓词求值）
 *
 * testDir 指向 gallery __tests__；启动本地 python3 -m http.server 8080 托管三件套。
 * fixture manifest 由 __tests__/fixtures/gen-manifest.mjs 生成（含三变体）。
 */
export default defineConfig({
  testDir: "./__tests__",
  testMatch: /.*\.acceptance\.test\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:8088",
    viewport: { width: 390, height: 844 }, // iPhone 12 尺寸（移动端优先）
    actionTimeout: 8_000,
    navigationTimeout: 10_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        channel: undefined,
        // muted autoplay 在无 user gesture 时默认被 Chromium 拦截。gallery 视频流契约
        // （S4.PM1 muted+playsinline 自动播）假设 muted autoplay 可用，E2E 跑在无手势
        // 环境需显式放开策略。微信 webview 实际有用户点击进入的 gesture，生产不受影响。
        launchOptions: {
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: {
    command: "python3 -m http.server 8088",
    port: 8088,
    cwd: __dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
