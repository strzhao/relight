import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "backend",
    environment: "node",
    // 全量 vitest（167 文件 + sharp/satori/onnx 重依赖）并发跑时资源争抢，
    // collect 阶段被拖到 600s+、timing 断言和 5s 边缘测试集体 flaky（空载单独跑全过）。
    // 限制 forks 并发 + 放宽 timeout，让每测试有充足资源。代价：全量更慢但稳定。
    testTimeout: 15000,
    hookTimeout: 15000,
    poolOptions: { forks: { maxForks: 2 } },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      exclude: ["src/__tests__/**"],
    },
  },
});
