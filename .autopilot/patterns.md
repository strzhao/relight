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

### [2026-05-03] @tanstack/react-virtual sentinel 必须放在虚拟容器内部而非作为虚拟项
<!-- tags: react, virtual-scroll, tanstack-virtual, IntersectionObserver, frontend -->

**Scenario**: 实现照片管理页面的无限滚动时，需要在虚拟列表底部放置 sentinel 元素，用 IntersectionObserver 监听触发加载更多。

**Lesson**: sentinel 不能作为 useVirtualizer 的虚拟项渲染——因为当它不在可视范围内时虚拟滚动不会渲染它（永远不可见=永远不触发回调）。正确做法是 sentinel 放在虚拟容器内部、所有虚拟行之后，通过绝对定位（transform: translateY(totalSize)）固定在列表末尾。另一方案是为 sentinel 额外增加一个计数槽位（count + 1），用虚拟化渲染它。

**Evidence**: 初次实现时 sentinel 始终不可见、无限加载不触发。修改后 sentinelRef 附加到 index >= flatItems.length 的 slot（count + 1），IntersectionObserver 正常回调。参见 `use-virtual-grid.ts` 第 116 行 `count: flatItems.length + (hasMore ? 1 : 0)` 和第 143-163 行 sentinel 渲染逻辑。

### [2026-05-04] BullMQ job.progress + Hono streamSSE 实现实时扫描进度推送
<!-- tags: bullmq, sse, hono, realtime, monitoring -->

**Scenario**: 需要在 admin 队列监控页实时展示扫描作业的详细进度（当前处理到哪个图片、已处理/总数、各类计数），而不仅仅是队列级别的作业状态。

**Lesson**: BullMQ `job.updateProgress(ScanProgress对象)` 将进度写入 Redis hash，`queue.getJobs()` 返回的 Job 实例的 `.progress` 属性同步读取该值（无需额外 Redis 查询）。通过 Hono `streamSSE()` 每 3s 拉取 snapshots + aggregateProgress 推送到前端，前端 `EventSource` 消费并渲染 per-job 内联进度条。

**Evidence**: SSE 端点 `GET /api/queues/:name/events` 推送每 3s 一帧 QueueSnapshot，包含每个作业独立的 `progress` 字段（phase/processed/totalFiles/newCount/regeneratedCount/currentFile 等）+ 所有活跃作业的 `aggregateProgress` 汇总。curl 验证 processed 值从 5620→5630→5640 实时递增。前端 `useQueueSSE` hook 基于 EventSource 实现，支持断线自动重连。

**关键实现**:
```typescript
// 后端：SSE 端点
return streamSSE(c, async (stream) => {
  const push = async () => {
    const snapshot = await getQueueSnapshot(queue); // 含 job.progress + aggregateProgress
    await stream.writeSSE({ data: JSON.stringify(snapshot), event: "snapshot" });
  };
  await push(); // 立即推送第一帧
  const interval = setInterval(push, 3000);
  while (!signal.aborted) await stream.sleep(1000); // 心跳
  signal.addEventListener("abort", () => clearInterval(interval));
});

// 前端：EventSource hook
const es = new EventSource(`/api/queues/${queueName}/events`);
es.addEventListener("snapshot", (e) => setSnapshot(JSON.parse(e.data)));
```

### [2026-05-04] BullMQ 5.76.4 队列名不允许包含冒号 `:`
<!-- tags: bullmq, queue, naming, migration -->

**Scenario**: 创建 BullMQ Queue 时使用 `"scan:storage"`、`"analyze:photo"` 等带冒号的名称，Worker 启动时报错 `":" is not allowed in queue names`。

**Lesson**: BullMQ 5.76.4 的队列名仅允许字母、数字、连字符和下划线。冒号 `:` 在旧版本（3.x）中常用于命名空间分隔，但在 5.x 中被移除。迁移时需将 `:` 替换为 `-` 或 `_`。

**Evidence**: `new Queue("scan:storage", ...)` → `Error: ":" is not allowed in queue names`；改为 `"scan-storage"` 后正常运行。
