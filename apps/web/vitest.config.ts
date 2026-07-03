import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
    testTimeout: 15000,
    hookTimeout: 15000,
    poolOptions: { forks: { maxForks: 2 } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["app/**", "components/**", "hooks/**", "lib/**"],
    },
  },
});
