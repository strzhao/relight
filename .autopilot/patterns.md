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

### [2026-05-02] 增量文件扫描：mtime+size 快速路径避免全量 SHA256 重复计算
<!-- tags: scan, performance, hash, filesystem, dedup -->

**Scenario**: 照片扫描 worker 每次运行都需要遍历存储源下的所有文件并计算 SHA256 去重。首次扫描 6000+ 文件需 10+ 分钟。后续每次扫描仍重新读取全部文件并计算 hash，即使 99% 文件未变更。

**Lesson**: 在 photos 表存储 `file_mtime` 字段，扫描时先查询已有记录构建 path→{mtime, size, hash} 缓存。遍历文件时先匹配 path + mtime + size，三者命中则直接复用已有 hash 跳过 SHA256。仅对新增/变更文件执行完整 hash 计算。

**Evidence**: NAS 照片目录 6077 个文件 ~36GB，首次扫描预估 10 分钟，增量扫描（无变更）<1 秒。修改前后流程对比：
```
修改前: listFiles() → 每个文件 getFileBuffer() → SHA256 → 查询去重 → 插入
修改后: listFiles() → 查询已有缓存 → mtime+size 匹配跳过 → 仅新文件 SHA256 → 插入/更新分流
```

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

### [2026-05-02] serverFetch<T> 的 as T 断言掩盖运行时 API 契约偏差
<!-- tags: api, types, runtime, serverfetch, contract -->

**Scenario**: 管理后台 photos 端点返回 `{ data: [...rows...], total, page }`（data 是数组），前端 `getPhotoAnalyses` 预期 `data` 为 `{ data: PhotoAnalysisItem[], total, page }` 嵌套对象。`serverFetch<T>` 使用 `return body.data as T` 直接断言，tsc 无法检测到运行时结构不匹配。前端页面渲染时 `data.data.length` 抛出 `TypeError: Cannot read properties of undefined (reading 'length')`，返回 HTTP 500。

**Lesson**: `serverFetch<T>` 的 `as T` 断言创建了一个信任边界——编译器假定 `body.data` 在运行时满足类型 T，但实际上没有运行时校验。当后端和前端对 API 契约理解不一致时（本案例中 data 是数组 vs data 是嵌套对象），`tsc --noEmit` 零错误但页面在浏览器中崩溃。必须在集成测试中使用 curl 实际调用端点来验证契约。

**Evidence**: `curl http://localhost:3001/admin/photos` → HTTP 500, Next.js error page 显示 `TypeError: Cannot read properties of undefined (reading 'length')` at AdminPhotosPage。后端修正 `c.json({ data: { data: rows, total, page } })` 后修复。修改前后 tsc 均通过，无法区分。
```
