# 模式与教训

### [2026-05-01] pnpm 原生模块构建需在 package.json 中声明 onlyBuiltDependencies
<!-- tags: pnpm, native-modules, build -->

**Scenario**: 新 monorepo 安装依赖时，pnpm 默认阻止 better-sqlite3、sharp、esbuild、@biomejs/biome 等原生模块的构建脚本。

**Lesson**: 在根 `package.json` 中添加 `pnpm.onlyBuiltDependencies` 数组，而非使用交互式 `pnpm approve-builds`（后者在 CI/脚本中不可用）。

**Evidence**: `pnpm install` 输出 "Ignored build scripts: @biomejs/biome@1.9.4, better-sqlite3@11.10.0, esbuild@..., sharp@..."。在 package.json 添加配置后 `pnpm install` 自动构建成功。

### [2026-05-01] Vitest workspace 模式需在根级别安装 vitest
<!-- tags: vitest, monorepo, testing -->

**Scenario**: 使用 `vitest.workspace.ts` 定义多项目测试配置，但 `pnpm test` 报 `vitest: command not found`。

**Lesson**: vitest.workspace.ts 由根目录 `vitest` CLI 驱动，即使各子包已安装 vitest，仍需 `pnpm add -D -w vitest` 在根 workspace 安装。

**Evidence**: `pnpm test` → `sh: vitest: command not found`；根级别安装后正常运行。

### [2026-05-01] Biome 1.9.4 使用 organizeImports 顶层键，非 assist
<!-- tags: biome, linting, config -->

**Scenario**: 沿用用户其他项目的 biome.json 配置，但 `assist.actions.source.organizeImports` 在 Biome 1.9.4 中报错 "Found an unknown key `assist`"。

**Lesson**: Biome 1.9.4 中 organizeImports 是顶层键 `"organizeImports": { "enabled": true }`，非 `assist` 下的嵌套配置。`assists` 键（带 s）在更新的版本中存在但功能不同。

**Evidence**: `biome check .` → `Found an unknown key assist. Known keys: $schema, extends, vcs, files, formatter, organizeImports, linter...`；修改后 lint 通过。

### [2026-05-02] BullMQ 重试配置在 Queue.defaultJobOptions 而非 Worker 构造函数
<!-- tags: bullmq, queue, worker, retry -->

**Scenario**: 实现 scan-storage 和 analyze-photo worker 时，需要在 BullMQ 中配置重试策略（attempts=3, exponential backoff）。

**Lesson**: BullMQ 的 attempts 和 backoff 参数通过 Queue 构造函数的 `defaultJobOptions` 设置，而非 Worker 构造函数。Worker 只接受 `connection`、`concurrency` 等运行参数。如果在 Worker 侧设置重试，不会生效。

**Evidence**: 
```typescript
// ✅ 正确：在 Queue 侧设置
const scanQueue = new Queue("scan:storage", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});

// Worker 侧不需要重试参数
new Worker("scan:storage", scanStorageWorker, { connection, concurrency: 1 });
```

### [2026-05-03] Hono streamSSE() 实现 BullMQ 队列实时监控推送
<!-- tags: hono, sse, bullmq, monitoring, streaming -->

**Scenario**: 实现 /admin/queues 队列监控页面时，需要后端实时推送队列状态（作业计数 + 最近作业列表）到前端，无需双向通信。

**Lesson**: 使用 Hono 内置 `streamSSE()` 辅助函数而非引入 WebSocket 库或依赖 BullMQ QueueEvents。核心模式：
1. `streamSSE(c, async (stream) => {...})` 建立 SSE 连接
2. `c.req.raw.signal` 检测客户端断开，通过 `abort` 事件清理 `setInterval`
3. `stream.writeSSE({ data, event })` 推送命名事件
4. `stream.sleep(1000)` 保持 stream 活跃，防止自动关闭
5. 客户端使用浏览器原生 `EventSource` 接收，天然支持自动重连

**Evidence**:
```typescript
// 后端 SSE 端点
return streamSSE(c, async (stream) => {
  const signal = c.req.raw.signal;
  const push = async () => {
    const snapshot = await getQueueSnapshot(config.queue);
    await stream.writeSSE({ data: JSON.stringify(snapshot), event: "snapshot" });
  };
  await push(); // 立即推送第一帧
  const interval = setInterval(async () => {
    if (signal.aborted) return;
    await push();
  }, 3000);
  signal.addEventListener("abort", () => clearInterval(interval), { once: true });
  while (!signal.aborted) await stream.sleep(1000);
  clearInterval(interval);
});
```

```typescript
// 前端 Hook
const eventSource = new EventSource(`/api/queues/${queueName}/events`);
eventSource.addEventListener("snapshot", (e) => {
  setSnapshot(JSON.parse(e.data));
  setConnected(true);
});
```
