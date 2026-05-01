import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm dev",
    port: 3001,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:3001",
  },
});
