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

### [2026-05-03] CLI 委托安全四要素：execFile 数组 + realpath 校验 + tmpdir 隔离 + AbortController 超时
<!-- tags: security, child_process, execFile, cli, backend, heic -->

**Scenario**: 需要从 Node.js 调用外部 CLI 工具（`heif-convert`）处理用户上传文件，需防范命令注入、路径遍历、资源泄漏、临时文件残留等风险。

**Lesson**: 四个安全要素缺一不可：
1. **execFile 数组参数**（非 exec/spawn shell 字符串）— 每个 argv 元素独立传递，shell 元字符不会被解释
2. **fs.realpath 输入校验** — 确认输入文件存在且为普通文件（拒绝符号链接目录、设备文件等）
3. **os.tmpdir() 隔离目录 + finally 清理 + process.exit 兜底** — 临时文件写入 `os.tmpdir()/prefix-{ts}-{rand}/`，finally 块清理正常路径，`process.on('exit', cleanup)` + `fs.rmSync`（同步版本）兜底异常退出
4. **AbortController 30s 超时** — 防止子进程僵尸，单文件转换硬限制

**Evidence**: 
```typescript
// 1. execFile 数组参数
execFile("heif-convert", ["-q", "85", resolvedPath, output], { timeout: 30000 });

// 2. realpath 校验
const resolvedPath = await realpath(input);
const stat = await fs.promises.stat(resolvedPath);
if (!stat.isFile()) throw new Error(`路径不是普通文件: ${input}`);

// 3. tmpdir 隔离 + finally
const tempDir = path.join(os.tmpdir(), `relight-heic-${ts}-${rand}`);
try { await decoder.convertToJpeg(input, output); }
finally { fs.rmSync(tempDir, { recursive: true, force: true }); }

// 4. exit 兜底 (必须用 fs.rmSync 同步版本)
process.on("exit", () => { fs.rmSync(tempDir, { recursive: true, force: true }); });
```
