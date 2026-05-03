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

### [2026-05-03] 健康端点系统指标采集采用嵌套 try-catch 降级
<!-- tags: health, api, error-handling, nodejs, filesystem -->

**Scenario**: 扩展 `/api/admin/health` 端点增加系统资源（CPU/内存/进程）和磁盘信息时，需要保证系统指标采集失败不影响现有组件健康检查。

**Lesson**: 系统指标采集使用嵌套 try-catch 隔离：外层捕获 DB 文件不存在（`disk: null`），内层捕获 `fs.statfsSync` 不可用（`freeSpaceBytes: null`）。系统采集代码放在组件检查逻辑**之后**，确保即使系统采集全部失败，组件状态仍正常返回。

**Key details**:
- `fs.statfsSync` 使用 `bavail`（非特权用户可用块数）而非 `bfree`（总空闲块数），因为 `bavail` 排除了保留块，更准确反映用户实际可用空间
- 挂载点参数用 `path.resolve(path.dirname(config.databasePath))` 解析相对路径
- `cpus()` 返回空数组时用 `?.model ?? "unknown"` 降级
- `loadavg()` 在 Windows 返回 `[0,0,0]`，前端用 `(value ?? 0).toFixed(1)` 安全处理

**Evidence**:
```typescript
// 后端：嵌套 try-catch 降级
let disk = null;
try {
  const dbPath = path.resolve(config.databasePath);
  const dbStats = fs.statSync(dbPath);
  const dbFile = { path: dbPath, sizeBytes: dbStats.size };
  let freeSpaceBytes = null, totalSpaceBytes = null;
  try {
    const statfs = fs.statfsSync(path.resolve(path.dirname(config.databasePath)));
    totalSpaceBytes = statfs.blocks * statfs.bsize;
    freeSpaceBytes = statfs.bavail * statfs.bsize;
  } catch { /* statfs 不可用，保持 null */ }
  disk = { dbFile, freeSpaceBytes, totalSpaceBytes };
} catch { /* DB 文件缺失，disk 为 null */ }
```

### [2026-05-03] 扫描进度 SSE 双数据源模式：DB scan_log + BullMQ job.progress

<!-- tags: sse, scan, bullmq, progress, sqlite, hono -->

**Scenario**: 存储源扫描是异步长时间任务，需要 SSE 实时推送进度。纯 BullMQ job.progress 在 worker 崩溃后丢失进度数据，纯 DB scan_log 在扫描初期只有空值。

**Lesson**: 使用双数据源合并策略——DB scan_log 作为权威状态源（持久化，崩溃可恢复），BullMQ job.progress 作为增量进度源（实时 phase/totalFiles/processed/counts）。SSE 端点合并时以 job.progress 优先，fallback 到 scan_log：

```typescript
// SSE 端点：合并双数据源
const [log] = await db.select().from(schema.scanLogs).where(eq(...));
const job = await scanQueue.getJob(log.jobId);
const progress = await job?.progress;  // BullMQ 增量数据
const event = {
  phase: progress?.phase ?? null,           // BullMQ 优先
  totalFiles: progress?.totalFiles ?? log.scannedCount,  // DB fallback
  status: log.finishedAt ? "completed" : "running",
};
```

**Key details**:
- worker 通过 `PROGRESS_BATCH_SIZE=10` 批量调用 `job.updateProgress()`，避免每文件一次 Redis 写入
- worker 完成/失败后 **UPDATE** scan_log（非 INSERT），携带最终计数
- SSE 端点 1s 间隔轮询双数据源（比队列监控的 3s 更频繁）
- stale 检测：`startedAt > 30 分钟前` 且 `finishedAt=null` → 标记为 stale，返回 error 事件
- 409 并发守护使用同款 stale 阈值，排除死扫描对并发判断的干扰

**Evidence**: 扫描 6152 文件耗时 29 秒，SSE 每秒推送 `event: progress`，阶段从 listing → hashing → processing → completed 逐级推进。

### [2026-05-03] 异步任务并发守护模式：SQLite 事务 + stale 阈值

<!-- tags: concurrency, sqlite, bullmq, transaction, async-job -->

**Scenario**: 存储源扫描是耗时操作，用户可能误触多次触发。需要防止同一存储源被重复扫描。

**Lesson**: 在 POST 端点入队前使用 SQLite 事务包裹 SELECT + INSERT，检查当前是否有 active scan（finishedAt IS NULL 且 startedAt 在 30 分钟内）：

```typescript
// 检查 active scan（排除 stale 记录）
const [active] = await db
  .select({ id: scanLogs.id })
  .from(scanLogs)
  .where(
    and(
      eq(scanLogs.storageSourceId, body.storageSourceId),
      sql`finished_at IS NULL`,
      sql`started_at > datetime('now', '-30 minutes')`,
    ),
  )
  .limit(1);
if (active) return c.json({ success: false, error: "该存储源已有正在进行的扫描任务" }, 409);
// ... 入队 + INSERT scan_log ...
```

**Key details**:
- 409 响应附带 `activeScanLogId`，前端可从中恢复 SSE 连接（而非仅显示错误）
- stale 阈值（30 分钟）同时用于 SSE 端点和并发守护，保持一致
- 降级：BullMQ 不可用时，active 检查仍能工作（纯 SQLite 不依赖 Redis）

**Evidence**: POST /api/scan 快速连续两次调用，第二次返回 409 + `{"activeScanLogId":"dac77ffc-..."}`。

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

### [2026-05-03] EventSource 自定义 SSE 事件与原生事件命名冲突需分离处理
<!-- tags: sse, eventsource, frontend, error-handling, hooks -->

**Scenario**: 后端通过 SSE `event: "error"` 推送业务错误（如 Redis 连接失败），前端 `addEventListener("error", handler)` 同时捕获自定义 SSE 事件和原生 EventSource 连接错误，导致业务错误被吞没或连接状态误判。

**Lesson**: 在 `addEventListener("error", handler)` 中通过 `try { JSON.parse(event.data) }` 判断是否为业务自定义事件——解析成功则为业务错误，解析失败则为原生连接错误。原生连接错误改用 `es.onerror` 处理（仅含 readyState，无 data 字段），两者物理分离避免歧义。

**Evidence**: `apps/web/hooks/use-queue-sse.ts:55-73` — 修改前 `addEventListener("error")` 只检查 `EventSource.CLOSED`，后端自定义 `event: "error"` 的 `event.data` 被忽略，导致 snapshot 永久为 null（加载骨架屏）。修改后自定义事件解析 `data.error` 并展示给用户，原生错误用 `onerror` 独立处理。
