### [2026-05-08] Drizzle `onConflictDoNothing()` 配 `.returning()` 时同冲突返回空数组

<!-- tags: drizzle, sqlite, onconflict, returning, orm, bug -->

**Scenario**: 用 `INSERT ... ON CONFLICT DO NOTHING RETURNING *` 实现"幂等插入并立刻取回新行"——典型场景是写入有唯一约束的精选/汇总表，并需要拿到新行 id 做后续更新或下游引用。

**Lesson**: ORM 的 onConflictDoNothing 在冲突命中时不返回已有行，而是返回空数组；任何"取 returning[0]"的代码必须先做空数组提前 return（或显式回查），否则空对象解构/属性访问会触发 TypeError，且单测里第一次插入永远命中分支，掩盖该 bug。

**Evidence**: `apps/backend/src/jobs/daily-selection.ts` 阶段 3 — `db.insert(dailyPicks).values({...}).onConflictDoNothing().returning()` 同日重跑 daily-selection job 时返回 `[]`，原代码直接读 `insertedRows[0].id` 抛 `TypeError: Cannot read properties of undefined`；plan-reviewer 第一轮在 design 阶段就识别为 BLOCKER，修复方式：`const insertedPick = insertedRows[0]; if (!insertedPick) { job.log("已存在，跳过"); return; }`。

### [2026-05-08] tsup 打包后 ESM `import.meta.url` 相对路径基准在 dev/prod 不同步

<!-- tags: esm, import-meta-url, tsup, dev-vs-prod, asset-path, build, bug -->

**Scenario**: 后端 ESM 模块通过 `new URL("../../assets/...", import.meta.url)` 引用工程内静态资产（字体、图片、Prompt 模板），希望同一份代码在 `tsx` 直跑源码与 `tsup` 打包后的 dist bundle 都能正确解析。

**Lesson**: 源码目录结构与构建产物目录结构不一致时，`import.meta.url` 在两边解析到的基准目录不同步，硬编码相对路径只能命中一边；要么在运行时嗅探产物特征（如 url 中是否包含构建输出目录名）走两套相对深度，要么在构建配置里把资产平移到 dist 内与源码同源的相对位置——单元测试常因只跑 tsx 路径而漏掉这类问题，必须在 prod build 后做一次 smoke。

**Evidence**: `apps/backend/src/lib/wallpaper/composer.ts:25` 用 `new URL("../../../assets/fonts/", import.meta.url)`：dev tsx 命中 `apps/backend/assets/fonts/`，prod dist 期望 `dist/assets/fonts/`，结果 prod 解析到不存在路径 → satori 抛错 → 路由 302 降级；QA Tier 1.5 真实场景命令 `curl /api/daily/.../wallpaper` 返回 47ms 302 才暴露（typecheck/build/单元测试全绿）。修复：检测 `import.meta.url.includes("/dist/")` 决定使用哪一段相对路径。

### [2026-05-08] Satori 的 `jsxImportSource` 子路径必须精确到子包根

<!-- tags: satori, jsx, jsx-runtime, esm, typescript, jsximportsource, bug -->

**Scenario**: 在 Node ESM 后端用 satori 渲染服务端 JSX，需要避开引入 React，于是用 satori 自带的 jsx 子包配 `tsconfig.json` 的 `jsxImportSource`。

**Lesson**: ESM 解析 `jsxImportSource` 时会自动拼 `/jsx-runtime` 后缀，因此其值必须是"暴露 jsx-runtime 入口的那个子包根目录"，不是父包名也不是更深路径；猜错路径会在运行时（不是编译时）抛 `Cannot find module .../jsx-runtime`，导致 typecheck 通过、合成路由全失败。先在 node 中 `await import("<candidate>/jsx-runtime")` 验明能解析再写入 tsconfig 是更安全的做法。

**Evidence**: 蓝队首版 `tsconfig.json` 写 `jsxImportSource: "satori"`，期望 ESM 解析为 `satori/jsx-runtime`，实际 satori 把 jsx 入口放在子包 `satori/jsx`，要的是 `satori/jsx/jsx-runtime`；正确写法 `jsxImportSource: "satori/jsx"`。typecheck/build 全部通过、单元测试也跑过（fixture 在 dev tsx 下偶然命中），仅 prod 实时合成路径暴露报错。

### [2026-05-06] DB 中 file_path 可能是绝对路径时用 path.resolve 而非 path.join

<!-- tags: path, file-system, nas, smb, storage, route, bug -->

**Scenario**: relight 后端 `/api/photos/:id/raw` 路由首次实现用 `path.join(rootPath, filePath)` 拼接路径，单元测试通过（fixture 用相对路径）。Tier 1.5 真实场景 curl 一个 NAS 上的照片返回 404 "文件不存在"。生产 DB 里 `file_path` 字段实际存的是绝对路径（如 `/Users/.../nas-photos/.../IMG.HEIC`），与 `rootPath`（`/Users/.../nas-photos`）拼接后产生 `/Users/.../nas-photos/Users/.../nas-photos/.../IMG.HEIC` —— 双前缀。

**Lesson**: 当 DB 中 `file_path` 可能存绝对路径（NAS/SMB/外部源历史数据），必须用 `path.resolve(rootPath, filePath)`，它在 filePath 是绝对路径时直接采用 filePath 忽略 rootPath。`path.join` 只做字符串拼接，不区分绝对/相对，会产生坏路径。

**对照已有代码**: `routes/photos.ts:226` 的 `/original` 路由原本就用 `path.resolve`，新增 `/raw` 路由复制粘贴时改成了 `path.join` 是退化；`daily-selection.ts:163` 也用 `path.join`，目前正常工作只是因为视频 winner 直接读 `thumbnailPath`（thumbnailPath 总是绝对路径，path.join 用不上）。所有新增涉及 DB 路径拼接的代码默认用 `path.resolve`。

**Why 这很重要**: 单元测试发现不了——fixture 通常用相对路径或 in-memory 路径，`path.join` 和 `path.resolve` 行为相同。只有 Tier 1.5 真实场景（curl 真实生产 photoId）才会暴露。这是"测试通过但生产挂"的典型场景，强化"必须跑真实场景"的纪律。

### [2026-05-06] BullMQ Job mock 必须含 log/updateProgress 等接口方法

<!-- tags: bullmq, vitest, mock, job, testing, integration -->

**Scenario**: 红队 acceptance test 直接调 `dailySelectionWorker({ data: {}, id: "test" })`，Worker 内部调 `job.log("...")` 报 `TypeError: job.log is not a function`，三个测试全部失败。

**Lesson**: BullMQ Job 接口包含 `log`、`updateProgress`、`updateData`、`getState` 等方法，生产代码常用 `job.log()` 输出步骤日志。直接传 `{ data, id }` 字面量当 Job 是不完整的 mock。建议项目内统一一个 helper：

```ts
function createMockJob(data: Record<string, unknown> = {}, id = "test") {
  return {
    data,
    id,
    name: "test-job",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as any;
}
```

放在 `__tests__/` 共享或测试文件顶部。relight 项目已有先例 `apps/backend/src/__tests__/daily-worker.acceptance.test.ts:227` 采用这个模式。

**Why 这很重要**: BullMQ 文档把 `job.log` 定义为可选辅助 API，项目代码却广泛使用——mock 不完整是新写测试的常见绊脚石。Job interface 实际包含 30+ 方法，但实测只需 mock 真正被调用的那几个。

### [2026-05-06] 视频 daily-selection 阶段 2 必须读 cover JPEG 而非整视频文件

<!-- tags: video, daily-selection, sharp, oom, cover-frame, ai-vision, performance, design -->

**Scenario**: 每日精选阶段 2 视觉模型给 winner 写叙事文案，原本对所有 winner 走 `adapter.getFileBuffer(fullPath) → sharp(buffer).resize(2048).jpeg().toBuffer()`。当 winner 是视频时这条路径双重崩溃：(1) 读取整个视频文件到 Buffer（GB 级 → OOM 风险）；(2) `sharp` 不支持视频解码（预编译 libvips 不含 ffmpeg）→ 抛 invalid format 异常。

**Lesson**: 视频在分析阶段已经生成了 cover 缩略图（`photos.thumbnailPath` 存绝对路径），daily-selection 阶段 2 直接读 cover JPEG：

```ts
if ((winner.photo.mediaType ?? "image") === "video") {
  if (!winner.photo.thumbnailPath) {
    throw new Error("视频无 cover 缩略图");  // 触发已有模板 fallback
  }
  const fs = await import("node:fs/promises");
  const coverBuffer = await fs.readFile(winner.photo.thumbnailPath);
  buffer = await sharp(coverBuffer).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
} else if (ext === ".heic" || ext === ".heif") {
  // heic 解码路径
} else {
  // sharp 普通路径
}
```

cover JPEG 是 800px max（thumbnail 生成时压缩过），远小于视频原文件，sharp 处理无虞。

**Why 这很重要**: 阶段 2 的目的是"视觉模型理解 winner 的画面"，对视频来说 cover frame 已包含画面信息，没必要也不应该读取整个视频。与"视频在分析阶段用 sprite 多帧"的设计一致：只在视频专属分析（analyze-photo job）里抽取多关键帧；daily-selection 阶段 2 复用 cover 即可。"thumbnailPath null 时 throw" 是有意设计——触发已有模板 fallback，避免 BullMQ 重试风暴（与 decisions.md 的"格式门用 return 而非 throw"对应——这里 throw 给 catch，不是抛出 worker）。

### [2026-05-06] Whisper.cpp / mlx-whisper / faster-whisper 三引擎 CLI 输出位置 — 必须从 outputDir/<stem>.json 读，绝不解析 stdout

<!-- tags: whisper, cli, child-process, json, stdout, ai, transcribe, bug -->

**Scenario**: 集成本地 `martin/scripts/transcribe.py`（同时支持 mlx/openai-whisper/faster-whisper 三引擎）做视频音频转录。脚本调用形式 `python3 transcribe.py audio.wav --output-format json --output-dir <tmp>`。直觉认为 stdout 输出 JSON 直接 `JSON.parse(stdout)` 即可。

**Lesson**: 这类 CLI 的设计是**结果写文件，stdout 只是人类可读进度日志**。stdout 内容形如：
```
引擎: mlx | 模型: large-v3-turbo | 语言: zh
输入: /tmp/audio.wav
[mlx-whisper] 加载模型 'large-v3-turbo'...
输出: /tmp/output/audio.json
耗时: 5.2s | 文本长度: 234 字
```
解析这个会失败。**真正的 JSON 在 `<outputDir>/<stem-without-ext>.json`** — 等 `child_process.spawn` 的 close 事件 + `code === 0` 后再 `fs.readFile()` 读取并 `JSON.parse`。

**Why 这很重要**: plan-reviewer 把这点列为 BLOCKER 是对的——这是会让实现"看起来工作"（spawn 不报错）但实际拿到错误结果（解析进度日志失败）的隐蔽 bug。三引擎共享 `--output-dir <stem>.json` 输出契约，是 CLI 设计的标准模式而非 transcribe.py 特例。

**Code shape**:
```ts
const proc = spawn(python, [script, audioPath, '--output-format', 'json', '--output-dir', tmpDir]);
proc.stdout.on('data', () => {});  // 丢弃，只是日志
proc.on('close', async (code) => {
  if (code !== 0) reject(...);
  const stem = path.basename(audioPath, path.extname(audioPath));
  const json = await fs.readFile(path.join(tmpDir, `${stem}.json`), 'utf-8');
  resolve(JSON.parse(json));
});
```

### [2026-05-06] worktree symlink + lint-staged stash 失败 → skip-worktree 隐藏虚假 deletion

<!-- tags: worktree, lint-staged, husky, git, symlink, stash -->

**Scenario**: worktree 中 `.autopilot` 是 symlink 指向主仓库的真实目录。git 视角下 worktree 内的 `.autopilot/foo` 文件本来 tracked 但工作树访问要走 symlink，git status 把它们标为 ` D`（unstaged deletion）。lint-staged 在 pre-commit 时跑 `git stash --keep-index` 备份 worktree 改动，stash 试图处理这些 D 时报错：`error: '.autopilot/decisions.md' is beyond a symbolic link` → 整个 commit 失败。

**Lesson**: 解决办法是在 worktree 中 `git update-index --skip-worktree` 这些路径，让 git 假装它们没变：
```bash
git diff --diff-filter=D -z --name-only | xargs -0 git update-index --skip-worktree
```
之后 lint-staged stash 就能跳过这些路径，commit 顺利通过。`skip-worktree` 是 worktree 局部设置，不污染主仓库。

**Why 这很重要**: 这个问题在 worktree 协作场景反复出现（symlink 共享知识库是常见模式）。直觉解法是 `--no-verify` 跳过 hook，但这违反"不绕过质量检查"的纪律。skip-worktree 是真正的根因解法：**告诉 git 这些路径在 worktree 里不应该被 worktree-level diff 看到**。

**Pre-installed worktree setup 应该自动做这个**：worktree-setup 脚本在 symlink `.autopilot` 之后立即跑一次 skip-worktree，避免后续 commit 都遇到这个坑。

### [2026-05-05] worktree 中 e2e 测试需切到不同端口启动 dev server，主仓库进程不会同步代码

<!-- tags: worktree, e2e, playwright, nextjs, dev-server, port -->

**Scenario**: 在 git worktree (`/.claude/worktrees/photo`) 修改了 `apps/web/app/photos/page.tsx`，跑 Playwright e2e 测试访问 `localhost:3001`，断言一直失败。代码 grep 确认修复已落地，但 e2e 看到的页面仍是旧版（"上滑加载更多"文字而非"加载失败，点击重试"）。

**Lesson**: dev server 是独立进程，服务的是**启动它时所在目录**的代码，与 git worktree 完全无关。`ps aux | grep next` 看进程的 cwd 路径，若是 `/Users/stringzhao/workspace/relight/apps/web/...`（主仓库）则它在跑主仓库代码；worktree 的代码改动它看不到。

**修复**：
1. 保留主仓库 dev server（用户可能正在用）
2. 在 worktree 启动新 dev server 用不同端口：`cd <worktree>/apps/web && pnpm exec next dev --turbopack -p 3010`
3. e2e 测试用临时 playwright config 覆盖 baseURL：`use: { baseURL: "http://localhost:3010" }`
4. `pnpm exec playwright test --config=playwright.config.tmp.ts ...`

**Why 这很重要**: 不知道这点会浪费大量时间在调试"测试 trigger 错误"或"实现 bug"上，而真因是测试根本没接触到改动后的代码。检查清单："改动了 worktree 代码 + e2e 失败 + 看上去合理但实测不通过" → 第一时间 `ps aux | grep next` 看进程 cwd。

**Evidence**: 本次 4 个 Playwright 用例切到 :3010 后从全部失败变成 4/4 全过（8.0s）。`turbopack.root` 推断警告可忽略（不影响功能），但若严重影响可在 next.config.ts 显式设置。

### [2026-05-04] 扫描收录与 AI 分析使用两层扩展名过滤，分离关注点

<!-- tags: backend, scan, extension-filter, two-layer, separation-of-concerns -->

**Scenario**: 扫描阶段需要收录所有文件格式（含暂不支持 AI 分析的视频和 RAW），但 AI 分析阶段只处理视觉模型支持的格式。单一扩展名列表无法满足两层不同需求。

**Lesson**: 使用两层扩展名集合分离关注点：
- `SCAN_EXTENSIONS`（local.ts）：扫描收录层 — 包含所有格式（图片 + RAW + 视频），确保后续可扩展
- `AI_SUPPORTED_EXTENSIONS`（analyze-photo.ts）：AI 分析层 — 仅含视觉模型可处理的格式（含需转换的 DNG/HEIC）
- 新增格式时只需在对应的 Set 中添加，互不影响

**Evidence**: `local.ts:10-30` 的 `SCAN_EXTENSIONS` 包含 16 种格式（图片/R AW/视频），`analyze-photo.ts:15-26` 的 `AI_SUPPORTED_EXTENSIONS` 包含 10 种图片格式。两层独立维护。

### [2026-05-04] 非 HEIC 图片在 AI 视觉分析前用 sharp 缩小尺寸减少 payload

<!-- tags: ai, vision, sharp, image-resize, performance, base64 -->

**Scenario**: 在 AI 视觉 API 调用前准备图片数据时，JPEG/PNG/WEBP 等非 HEIC 格式的图片直接用原始分辨率 base64 编码。

**Lesson**: 高分辨率照片（6000x4000）全分辨率 base64 可达 12MB+，应统一用 sharp 缩放到 2048px（与 HEIC 处理一致）并 JPEG quality 85 编码，payload 降到 ~300KB。2048px 对美学评分、构图分析、色彩分析已足够，视觉模型内部会自行降采样，超大图片不会提升分析质量。

**Evidence**: `apps/backend/src/jobs/analyze-photo.ts:63-68` — 新增 else 分支对非 HEIC 图片做 sharp resize；优化前单图 payload 7-27MB，优化后 ~300KB，处理时间从 30-60s 降到 8-15s。

# 模式与教训

### [2026-05-04] macOS SMB 挂载持久化 — LaunchAgent 周期保活 + nsmb.conf 调优
<!-- tags: macos, smb, nas, mount, launchagent, nsmb-conf, shell -->
- **问题**: SMB 共享经常自动断开（NAS 空闲超时 + macOS 内核 deadtimer 超时链）
- **方案**: LaunchAgent `StartInterval: 300` 周期执行幂等挂载脚本 + `/etc/nsmb.conf` 配置 `soft=yes,validate_neg_off=yes,max_resp_timeout=60,notify_off=yes`
- **macOS 适配**: 无 `flock` 用 `mkdir` 原子锁、无 `timeout` 用后台进程 + sleep + kill、无 `mountpoint` 用 `mount | grep " on $DIR "`

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

### [2026-05-04] SSE 进度追踪使用 DB 轮询 + QueueEvents 双向更新模式
<!-- tags: sse, bullmq, queue-events, progress, db-polling, pattern -->

**Scenario**: 批量异步任务（扫描/分析）需要通过 SSE 向多客户端推送实时进度。方案选择：纯 QueueEvents 流 vs DB 轮询 vs 混合。

**Lesson**: 采用 DB 轮询（SSE 端点每 1s 查询数据库）+ QueueEvents 监听器（Worker 进程监听 completed/failed 事件写入 DB 计数器）的双向架构：
1. SSE 端点从 DB 读取进度（`streamSSE` + `setInterval` 1s 轮询），支持多客户端同时连接
2. QueueEvents 全局监听器在 Worker 进程中独立运行，通过 `analyze_batch_jobs` 映射表反向查找 batchId，原子更新计数器（`sql\`completed_count + 1\``）
3. `finalizeBatchIfDone()` 检查 `completedCount + failedCount >= totalCount` 时设置 `finishedAt`
4. Stale 检测：超过 30 分钟未完成的 batch 推送 `stale` 状态并关闭流

**Why 纯 QueueEvents 不够**：QueueEvents 是进程本地的，SSE 客户端可能位于不同进程；QueueEvents 不持久化历史事件，断线重连后无法恢复当前进度。

**Why DB 轮询优于纯内存**：Worker 重启后进度不丢失；多 SSE 客户端无需额外协调；与现有 scan SSE 模式一致。

**Evidence**: `scan-progress-panel.tsx` 的扫描 SSE + `admin.ts` 的分析 SSE 均采用此模式；`workers/index.ts` 的 `analyzeEvents` QueueEvents 监听器验证了双向更新正确性；红队 60 个验收测试全部通过。

### [2026-05-04] sharp 处理网络/SMB 挂载路径文件时先 readFile 读入 Buffer

<!-- tags: sharp, smb, network-path, seek-error, image-processing -->

**Scenario**: 缩略图生成和照片元数据提取使用 `sharp(filePath)` 直接从文件路径读取。当文件位于 SMB 网络挂载盘（如 macOS `/Volumes/` 挂载）时，sharp 内部触发 `bad seek` 错误导致处理失败。

**Lesson**: 对所有来自网络存储（SMB/NFS/WebDAV）的文件，先通过 `readFile(sourcePath)` 将完整文件读入内存 Buffer，再将 Buffer 传给 `sharp(buffer)`。这同样适用于 `sharp().metadata()` 调用——先 `readFile` 再 `sharp(buf).metadata()`。

**注意**: HEIC 转换路径已有独立的 `heicFileToJpeg` 函数（内部已使用 `readFile`），无需额外修改。视频处理走 ffmpeg，不受 sharp 影响。

**Evidence**: 生产环境 37 个文件触发 `Error: bad seek` 错误。修复后缩略图生成和元数据提取管线使用 Buffer 路径。参见 `thumbnail.ts:17` (`readFile` → `sharp(buffer)`) 和 `local.ts:260` (`fs.readFile` → `sharp(buf).metadata()`)。

### [2026-05-04] HEIC 文件可能伪装：扩展名 .heic 实际为 JPEG 内容

<!-- tags: heic, jpeg, content-detection, format-disguise, sharp, heic-decode -->

**Scenario**: 照片库中存在大量文件扩展名为 `.heic` 但实际内容为 JPEG（魔术数字 `ffd8ff`）。仅依赖扩展名选择解码器会导致 `heic-decode` 解码失败。

**Lesson**: HEIC 处理应采用双路径降级策略：
1. 主路径：`heic-decode({ buffer })` 尝试解码
2. fallback 路径：catch → `sharp(buffer)` 按内容自动检测格式

sharp 能从文件内容（而非扩展名）自动识别 JPEG/PNG/WebP 等真实格式，无需预先判断。

**Evidence**: 生产扫描日志中 294 个文件 `heic-decode` 失败。`file` 命令确认这些 `.heic` 文件实际为 "JPEG image data"。参见 `heic.ts:33-46` try/catch 降级实现。

**Scenario**: 实现照片管理页面的无限滚动时，需要在虚拟列表底部放置 sentinel 元素，用 IntersectionObserver 监听触发加载更多。

**Lesson**: sentinel 不能作为 useVirtualizer 的虚拟项渲染——因为当它不在可视范围内时虚拟滚动不会渲染它（永远不可见=永远不触发回调）。正确做法是 sentinel 放在虚拟容器内部、所有虚拟行之后，通过绝对定位（transform: translateY(totalSize)）固定在列表末尾。另一方案是为 sentinel 额外增加一个计数槽位（count + 1），用虚拟化渲染它。

**Evidence**: 初次实现时 sentinel 始终不可见、无限加载不触发。修改后 sentinelRef 附加到 index >= flatItems.length 的 slot（count + 1），IntersectionObserver 正常回调。参见 `use-virtual-grid.ts` 第 116 行 `count: flatItems.length + (hasMore ? 1 : 0)` 和第 143-163 行 sentinel 渲染逻辑。

### [2026-05-04] Sharp EXIF Buffer 格式兼容 + 轻量 TIFF 解析器
<!-- tags: sharp, exif, tiff, metadata, image-processing -->

**Scenario**: 从照片 EXIF 提取拍摄时间（DateTimeOriginal），使用已有的 sharp 依赖获取 EXIF Buffer，但 sharp 不解析 EXIF 字段值，只返回原始 Buffer。

**Lesson**: Sharp `metadata().exif` 返回的 Buffer 有两种格式：
1. 纯 TIFF 格式 — Byte order marker (II/MM) 在 offset 0
2. APP1 包装格式 — "Exif\0\0" 前缀在 offset 0-5，TIFF 从 offset 6 开始

编写轻量 TIFF 解析器（~60 行）即可提取 tag 0x9003，无需引入第三方 EXIF 库（增加 ~500KB）。解析器需处理：
- 双字节序（little-endian "II" / big-endian "MM"）
- 12 字节固定 IFD 条目
- inline value（≤4 bytes）vs offset value（>4 bytes）
- ASCII 字符串 null terminator 裁剪

**Evidence**: `storage/local.ts:28-96` 的 `findTiffStart()` + `parseExifDateTimeOriginal()`，兼容 Sharp 创建的测试 JPEG（无 EXIF prefix，纯 TIFF 从 offset 0 开始）。全部 25 个 storage adapter 测试和 21 个 scan-storage 测试通过。

### [2026-05-04] IntersectionObserver 在 React 中的生命周期管理——避免级联加载循环

<!-- tags: react, intersectionobserver, infinite-scroll, ref, useeffect, cascade -->

**Scenario**: 无限滚动页面的 IntersectionObserver 依赖 `isFetchingMore` 作为 effect 依赖项，导致 observer 随加载状态变化频繁销毁重建。新 observer 创建后检测到 sentinel 仍在视口内 → 立即触发 `onLoadMore()` → 形成「加载完成 → observer 重建 → 触发加载」的无限循环。

**Lesson**: IntersectionObserver 应遵循「创建一次、永不重建」原则：
1. 回调通过 ref 读取最新状态（hasMore/isFetchingMore/onLoadMore），避免闭包过期
2. 使用 `observerRef` 标记是否已创建，后续 effect 重跑时检查已有则跳过
3. observer 仅在组件卸载时 disconnect，不因数据变化而销毁
4. effect 依赖 `flatItems.length`（信号：骨架屏 → 正常视图），但内部 `observerRef.current` 防止重建

**Why 这很重要**: observer 销毁重建是无限加载中最隐蔽的 bug 来源——代码看起来每次 effect 跑完只有一个 observer，但实际上每次重建都是一次新的交叉状态变化检测，导致级联。冷却期只能缓解，不能根除；observer 重建才是根本原因。

**Evidence**: 修复前 e2e 测试仅 1 次 API 调用（observer 未创建），修复后 5/5 Playwright e2e 通过，滚动到底部正常触发 page 2/3/...。参见 `use-virtual-grid.ts:144-185` 的 `loadMoreRef` + `observerRef` + 两个分离的 `useEffect`。

### [2026-05-04] DB 与文件系统反向校验时需加安全阀防止存储断连误删

<!-- tags: backend, scan, safety, orphan-cleanup, storage, nas -->

**Scenario**: 在 scan-storage 流程中新增 cleanupOrphans，用 `adapter.listFiles()` 返回的文件列表与 DB 对比，差集即为孤儿记录。但 QA 阶段发现：NAS/SMB 存储源未挂载时，`fs.readdir()` 不抛异常而是返回空数组 `[]`，导致该存储源全部 6142 条 DB 记录被识别为孤儿，若不加防护将全部误删。

**Lesson**: 任何基于文件系统列表的反向校验（DB 有但磁盘无 → 清理），**必须**加入安全阀：当孤儿比例超过阈值（如 >80%）且绝对数足够大（如 >50）时，跳过清理并发出告警。这是防御性编程的必要措施，不能因"当前仅 local 适配器"就忽略。安全阀应放在差集计算之后、事务删除之前。

**Evidence**: 主仓库 relight.db 查询显示 NAS 存储源 `/Users/stringzhao/nas-photos` 未挂载时抽样 100 条全部为孤儿。安全阀逻辑验证：NAS 断连 (6142/6142, 100%) → BLOCK；正常清理 (3/100, 3%) → ALLOW；用户大量删文件 (60/100, 60%) → ALLOW。参见 `scan-storage.ts:44-53`。

### [2026-05-04] Biome a11y 规则豁免应使用 biome.json overrides 而非内联注释

<!-- tags: biome, a11y, linting, config, lightbox -->

**Scenario**: Lightbox 组件使用 `role="dialog" aria-modal="true"` 自定义对话框，Biome 的 `useSemanticElements` 规则要求使用原生 `<dialog>` 元素。尝试用 `// biome-ignore lint/a11y/useSemanticElements: <explanation>` 内联注释压制，但注释位置多次调整仍不生效。

**Lesson**: 当整个目录/模块需要豁免某条 a11y 规则时，用 `biome.json` 的 `overrides` 字段按文件模式匹配豁免，比内联注释更可靠：
```json
{
  "overrides": [
    {
      "include": ["apps/web/components/ui/lightbox/**"],
      "linter": {
        "rules": {
          "a11y": {
            "useSemanticElements": "off"
          }
        }
      }
    }
  ]
}
```

**Why 内联注释不生效**: Biome 的 `// biome-ignore` 注释作用于**下一个语法节点**，在 JSX 中对最外层 `<div>` 生效但可能不影响嵌套的语义元素检测。文件级豁免更干净，尤其在自定义无障碍组件场景下。

**Evidence**: `biome check apps/web/components/ui/lightbox/` → `useSemanticElements` 错误。多次尝试 `// biome-ignore` 注释位置（组件顶部、JSX 内联）均未解决。添加 biome.json overrides 后 lint 通过。

### [2026-05-04] Next.js rewrites 不转发 SSE 流，EventSource 必须直连后端
<!-- tags: nextjs, sse, eventsource, proxy, rewrite, cors -->

**Scenario**: 前端使用 `EventSource` 连接 SSE 端点，URL 用相对路径 `/api/queues/:name/events`。Next.js 的 `rewrites` 配置将 `/api/*` 代理到 `http://localhost:3000/api/*`。页面能加载但 SSE 永远收不到数据。

**Lesson**: Next.js rewrites 对 SSE/EventSource 长连接会缓冲响应而非流式转发。`curl -N` 通过 Next.js 代理请求 SSE 端点直接超时无数据，直连后端则正常。EventSource 必须使用绝对 URL（`NEXT_PUBLIC_API_URL`）直连后端，配合后端 CORS（`Access-Control-Allow-Origin: *`）允许跨域。

**Evidence**: `timeout 4 curl -s -N "http://localhost:3001/api/queues/scan-storage/events"` → 超时无输出。`curl -s -N "http://localhost:3000/api/queues/scan-storage/events"` → 正常返回 `event: snapshot` 流。修复：`use-queue-sse.ts` 中 EventSource URL 从 `API_ROUTES.queues.events(name)` 改为 `${baseUrl}${API_ROUTES.queues.events(name)}`。

### [2026-05-05] HEIC 检测必须在 sharp resize 之前执行——sharp 预编译 libvips 不含 HEIC 解码
<!-- tags: heic, sharp, image-processing, code-order, bug -->

**Scenario**: 每日精选 Worker 阶段 2 需要读取胜者照片文件 → 缩放 → base64 发给视觉模型。HEIC 文件处理逻辑放在了 `sharp(buffer).resize()` 调用之后，导致 HEIC 照片走此路径时 sharp 抛异常直接进入 catch 块，永远使用模板文案而非 AI 生成文案。

**Lesson**: sharp 的预编译 libvips 不含 HEIC 解码支持（见 CLAUDE.md），因此必须在任何 sharp 调用之前检查文件扩展名。HEIC 文件走 `heicFileToJpeg()` 路径（内部调用 heic-decode WASM），非 HEIC 文件走 `sharp().resize()` 路径。两者互斥，不可先后执行。

**Evidence**: `jobs/daily-selection.ts:150-167` — QA 阶段代码审查发现此 bug。修复前：line 151 `sharp(buffer).resize()`（HEIC 在此抛异常）→ line 160-167 HEIC 检测（永不执行）。修复后：line 152-167 先检查扩展名再分支处理。类型检查 + lint + 1268 测试通过确认修复。

### [2026-05-05] Next.js dev server 不读 .env.local 的 PORT，必须靠包装脚本预注入

<!-- tags: nextjs, dev-server, env-loading, port-binding, dotenv -->

- **现象**：`apps/web/package.json` 的 `dev` 脚本去掉硬编码 `-p 3001` 后，依赖 Next.js 自动从 `.env.local` 读 `PORT` —— 但实际 Next.js dev server 在加载 `.env.local` **之前** 就读 `process.env.PORT` 决定监听端口，所以 `.env.local` 的 `PORT` 不生效，dev server 退回默认 3000
- **方案**：写一个轻量包装脚本 `apps/web/scripts/run-with-env.mjs`，`fs.readFileSync` 解析 `.env` / `.env.local` 注入到 `child_process.spawn` 的 env 后再 spawn `next dev`。`package.json` 的 `dev` / `start` 改成 `node scripts/run-with-env.mjs next dev --turbopack`
- **触发场景**：所有需要让 Next.js dev/start 端口由 `.env.local` 控制的场景（多 worktree 并行、Docker 多实例）
- **Evidence**: `apps/web/scripts/run-with-env.mjs:8-22` — 读已存在的 `.env*` 注入 spawn env；worktree 实测 `pnpm dev` 自动绑 :4863（来自 `.env.local`），未设 shell PORT

### [2026-05-05] pnpm workspace 子进程加载子包依赖时 cwd 必须在子包目录

<!-- tags: pnpm, workspace, dotenv, child-process, node-modules-resolution -->

- **现象**：测试代码 `spawnSync(node, ["-e", "require('dotenv')..."], { cwd: REPO_ROOT })` 失败 `Cannot find module 'dotenv'`。原因：pnpm workspace 不在根 `node_modules` 安装 `dotenv`，只在 `apps/backend/node_modules/` 下软链
- **方案**：子进程的 `cwd` 必须指向**实际声明该依赖的子包目录**（如 `path.join(REPO_ROOT, "apps/backend")`）。Node.js `require` 解析按 cwd 向上查找 `node_modules`
- **避坑**：`NODE_PATH` 环境变量也可绕过，但不推荐（破坏 pnpm 严格依赖树）
- **Evidence**: `apps/backend/src/__tests__/worktree-env.acceptance.test.ts:323-330` — `cwd: path.join(REPO_ROOT, "apps/backend")` 让子进程能正常 require dotenv
### [2026-05-05] qwen3 在 llama.cpp 上禁用思考模式必须用 chat_template_kwargs，thinking 字段是 vLLM 方言
<!-- tags: qwen3, llama-cpp, thinking-mode, openai-api, ai, performance, bug -->

**Scenario**: qwen3.6-35B 是推理模型，默认输出 chain-of-thought 到 `reasoning_content`，content 为空。要让它直接输出 JSON 必须禁用思考。OpenAI 兼容客户端写法 `thinking: { type: "disabled" }` 看起来像官方 API，实际上是 **vLLM/DashScope 方言**，llama.cpp 透传给 chat template 时**完全忽略**。结果：模型每次都跑完整 CoT 直到撞 max_tokens（4096）才停，单张照片分析 60-90s，且大量 token 浪费在思考链。

**Lesson**: qwen3 系列在 llama.cpp 上禁用思考的**唯一有效方式**是 `chat_template_kwargs: { enable_thinking: false }`。这是 qwen3 chat template 原生参数，llama.cpp 会透传给 jinja 模板。其他写法均无效：
- ❌ `thinking: { type: "disabled" }` — vLLM 方言，llama.cpp 忽略
- ❌ 用户消息加 `/no_think` — qwen3.6 不识别
- ✅ `chat_template_kwargs: { enable_thinking: false }` — completion_tokens 从 80（顶到 max）降到 9

**诊断方法**：发一个简短问题测试（max_tokens=80，问"用 15 个字介绍北京"），看 `usage.completion_tokens` 是否远小于 max_tokens。如果顶到上限且 `reasoning_content` 长 = 思考没禁掉。

**Evidence**: `apps/backend/src/ai/client.ts:55,91`。修复后实测单张分析延迟 60-90s → 40-58s，AI 评估器质量评分 100/100 不退化。注意 35B-A3B MoE 在 M4 Max 上 decode ~50 tok/s 是物理上限，单纯参数优化不能突破到 < 25s（要进一步提速需换 7B 视觉模型）。

### [2026-05-05] sharp resize 必须显式 withoutEnlargement: true，否则小图被放大反优化
<!-- tags: sharp, image-resize, withoutEnlargement, ai-payload, code-quality, bug -->

**Scenario**: 为减少 AI 视觉模型 payload，统一把图片 resize 到 1024×1024。但 `sharp().resize(1024, 1024, { fit: "inside" })` 默认对小图也会放大到 1024，反而增大 payload。3 个处理路径中 RAW/HEIC 显式带了 `withoutEnlargement: true`，普通 JPEG 路径却漏了，导致 < 1024px 的小图反而被放大。

**Lesson**: sharp resize 用作 payload 收紧时，**所有路径必须带** `withoutEnlargement: true`。这是同一类操作的不变量，不能某些路径带某些不带。代码审查时要把所有 `.resize()` 调用一起 grep 比对参数对齐。

**Evidence**: `apps/backend/src/jobs/analyze-photo.ts:128` — code-quality-reviewer 发现普通图片路径与 DNG/HEIC 路径不一致。修复后三路径参数完全对齐：`{ fit: "inside", withoutEnlargement: true }` + `quality: 75`。

### [2026-05-07] ESM 模块顶层 await 阻塞 vitest `await import()` → 测试 5s 超时

<!-- tags: vitest, esm, top-level-await, dynamic-import, redis, ioredis, worker, bug -->

**Scenario**: `apps/backend/src/workers/index.ts` 在加 worker meta 心跳时写了顶层 `await writeWorkerMeta()`（写 Redis 的初始 meta key）。生产环境跑得好（Redis 在），但 `analyze-optimization.acceptance.test.ts` 的 4 个 case 全部超时 5s 失败 — 这些 case 都用 `await import("../workers/index")` 触发 Worker 构造。问题：测试环境 Redis 不可用 → `redis.set(...)` 无限重试 → 顶层 await 永不 resolve → 模块 import 永远 pending → vitest 超时。

**Lesson**: ESM 模块的顶层 await 会让 `import` 等待该 promise resolve。如果操作依赖外部系统（Redis / DB / HTTP），import 就成了**阻塞同步操作**。在测试中 `await import(module)` 会被拖累至外部系统超时。**任何启动副作用都应 fire-and-forget**：

```ts
// ❌ 模块顶层 await 外部操作
await writeWorkerMeta();
const heartbeat = setInterval(() => writeWorkerMeta().catch(...), 60_000);

// ✅ fire-and-forget + 心跳兜底
const heartbeat = setInterval(() => writeWorkerMeta().catch(...), 60_000);
writeWorkerMeta().catch((err) => console.error("初始 meta 写入失败:", err));
```

**Evidence**: `apps/backend/src/workers/index.ts:34` — 改 fire-and-forget 后测试 duration 从 20s（4×5s 超时）降到 148ms。

**避坑信号**：测试看 `await import("...")` 形式时，对应模块的顶层语句必须是同步的或 lazy 的。如果 import 那边出现挂起 → 立刻怀疑顶层 await + 外部依赖。

### [2026-05-07] PM2 reload 中断 in-flight job 是预期行为，配 retry-failed 工具是正确处理

<!-- tags: pm2, supervisor, bullmq, worker, kill-timeout, reload, sigkill -->

**Scenario**: 给 BullMQ worker 加 PM2 supervisor 后，期望 `pnpm workers:reload` 不丢 job。实测：触发 3 张 force re-analyze，立即 reload — 1 张完成、2 张被中断进 failed（kill_timeout=10s 远短于 AI 分析耗时 30-60s）。最终通过 retry-failed 按钮恢复，3/3 都 completed。

**Lesson**: PM2 reload 在 graceful shutdown 后强制 SIGKILL（kill_timeout 之后）。BullMQ worker 接到 SIGTERM 后**不会**等所有 active job 完成 — 它会停止接新 job 但 active job 在 kill_timeout 内必须自己结束，否则被 SIGKILL → BullMQ 标记 failed/stalled。这不是 bug，是 supervisor 模型的约束：

- ❌ 期望：reload "无缝" — 所有 in-flight job 跑完再切换
- ✅ 现实：reload 中断长任务 + retry 工具兜底 = 0 task lost
- 调长 `kill_timeout` 不彻底解决（再长也可能撞到极慢任务），且会让"卡死的 worker 重启"变慢

**避免设计偏差**：不要追求"reload 不丢 job"作为硬指标，应该追求"reload + retry-failed = eventual completion"。

**Evidence**: `ecosystem.config.cjs` kill_timeout: 10000；`apps/backend/src/routes/queues.ts:287` POST /retry-failed 端点 — 设计文档场景 4 的 QA 验证记录在 `.autopilot/requirements/20260506-4-都一起优化，确实都/state.md`。

### [2026-05-07] xcodebuild ad-hoc 签名打包不能加 CODE_SIGNING_ALLOWED=NO

<!-- tags: xcodebuild, mac, code-signing, ad-hoc, hardened-runtime, gatekeeper, archive, bug -->

**Scenario**: 写 `apps/mac/build.sh` 一键 archive 脚本时，第一版按 archive 比 build 更"严格"的直觉，加了 `CODE_SIGNING_ALLOWED=NO`（同时保留 `CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO`）。plan-reviewer 指出：这个组合会让 Xcode 直接跳过任何签名步骤（包括最低 ad-hoc 签名），产物 `_CodeSignature/` 目录可能为空，到 macOS 14/15 上被 Gatekeeper 直接拒启动。

**Lesson**: ad-hoc 签名打包（`Sign to Run Locally`）的最小有效组合是 `CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO`，**不要**追加 `CODE_SIGNING_ALLOWED=NO`：

- `CODE_SIGN_IDENTITY=-` 表示用 ad-hoc 占位身份签名
- `CODE_SIGNING_REQUIRED=NO` 表示不强制有效身份（允许 ad-hoc）
- `CODE_SIGNING_ALLOWED=NO` 完全禁用签名工具链 — 与 ad-hoc 互斥

不同 xcodebuild 子命令（build / archive）需要的签名标志组合相同，不需要为 archive 加额外约束。修复后 build.sh 实测 6.17s 完成 ARCHIVE SUCCEEDED，产物 `Signature=adhoc`，`codesign --verify` 通过。

**Evidence**: `apps/mac/build.sh` (commit e2fab4b)；plan-reviewer 反馈见 `.autopilot/sessions/mac/requirements/20260507-007-package-readme/state.md` 「Plan Review」区段。

### [2026-05-07] Release+Hardened Runtime+LSUIElement APP 的 stdout 在 terminal 调用时会被吞

<!-- tags: macos, swiftui, hardened-runtime, lsuielement, stdout, release-build, debug-vs-release, code-signing -->

**Scenario**: Mac 壁纸 APP 在 Debug 构建中跑 `Relight.app/Contents/MacOS/Relight --self-test=codable` 能正常打印 + 退出 0；但 Release archive 后跑同一个 SelfTest 二进制：stdout 空 + 进程不退出（必须手动 kill）。codesign 显示 Release 构建启用了 Hardened Runtime（`flags=0x10002(adhoc,runtime)`）。

**Lesson**: 当 macOS APP 同时满足以下三个条件，从 terminal 直接调 `.app/Contents/MacOS/<binary>` 时 stdout 行为不可靠：
1. Hardened Runtime 启用（archive/Release 默认）
2. `LSUIElement = true`（菜单栏 APP，无 Dock 图标）
3. 命令行启动绕过 LaunchServices

GUI APP 二进制被 macOS 视为 NSApplication 主进程，不会自动绑定到调用方 terminal 的 stdout/stderr，命令行调用时输出可能消失或被重定向到 OSLog。**调试和 SelfTest 类回归测试必须使用 Debug 构建**（无 Hardened Runtime + 输出走 terminal），Release 产物只做 bundle 完整性 / `codesign --verify` / 用户实际 `open .app` 验证。

**避免设计偏差**：CI/QA 自动化验证不要基于 Release 产物跑命令行 SelfTest；要么走 Debug build，要么改用 OSLog 流读取（`log stream --predicate 'subsystem == "..."'`）。

**Evidence**: `apps/mac/build.sh` 产出 Release `.app`；codesign -dvv 输出 `flags=0x10002(adhoc,runtime)`；任务 006 `coordinator.acceptance.test.sh` 全跑通是因为它用的是 Debug build (`xcodebuild ... -configuration Debug`)。

---

## [2026-05-08] macOS App 行为异常先比 binary mtime vs 源码 mtime <!-- tags: macos, xcode, debug, derived-data, stale-build, swiftui, lsuielement, scene, debugging-pattern, bug -->

**Lesson**: 当 macOS App 表现"和源码不一致"（菜单栏图标缺失/出现不该有的窗口/旧 UI 残留），第一步 **先核对运行的 binary 是不是最新的**，而不是怀疑代码逻辑。常见错位：
- Xcode Cmd+R 跑的是 `~/Library/Developer/Xcode/DerivedData/<proj>-<hash>/Build/Products/{Debug,Release}/<App>.app`
- `./build.sh` 跑的是 `apps/mac/build/dist/<App>.app`
- Spotlight/Dock 启动的是 `/Applications/` 或 `~/Applications/`

三个路径互不覆盖，用户/开发者很容易"打开旧 App"却以为打开了新代码。

**诊断顺序**：
1. `stat -f "%Sm" <App>.app/Contents/MacOS/<binary>` vs `stat -f "%Sm" <重要源码>.swift` — 如果 binary 早于源码就是 stale build
2. `/usr/libexec/PlistBuddy -c "Print :LSUIElement" <App>.app/Contents/Info.plist` — 对比源码 Info.plist 是否一致
3. `nm <binary> | grep <关键 SwiftUI 类型>` — 验证关键 Scene/View 是否在 binary 里
4. 若用了 SwiftUI Scene 调整（如 WindowGroup → MenuBarExtra），还需 `defaults read <bundle-id>` 检查是否有 stale `NSWindow Frame <App>.<View>-1-AppWindow-1` UserDefault 残留 — 残留只是位置记忆，不会创造窗口，但会让人以为旧 Scene 还在生效

**为什么这是陷阱**：SwiftUI 的"代码即 UI"心智模型会让人觉得"源码改了行为就改了"，但 Xcode 不会自动 rebuild + macOS 也没有"哪个 .app 是当前版本"的概念，每个路径下的副本都是独立的可执行文件。

**Evidence**: 本次"Relight 文字窗口" bug 根因 = DerivedData 旧 Release 产物（mtime 早于 menu bar 改造提交 21.5h），`LSUIElement=false` + 旧 `WindowGroup{ContentView()}` 仍在；当前源码已经是 `MenuBarExtra` + `LSUIElement=true`。修复方式：删旧产物 + 重新 `./build.sh` + 拷到 `~/Applications/`。

### [2026-05-08] IntersectionObserver 监听条件渲染节点必须用 callback ref，不能用 useRef + useEffect

<!-- tags: react, intersectionobserver, callback-ref, conditional-rendering, useeffect, infinite-scroll, bug -->

**Scenario**: 无限滚动页面 sentinel 元素只在 list 状态渲染（loading/empty/error 状态下不渲染）；effect 写成 `useEffect(() => { observe(sentinelRef.current); }, [loadMore])`，loadMore 是稳定的 useCallback。初次 mount 时 sentinel 不存在，effect 早 return；后续数据加载完毕渲染 sentinel，但 effect 因 deps 未变不会重跑 → observer 永远不接入 → 无限滚动失效。

**Lesson**: 条件渲染或后期挂载的 DOM 节点配 IntersectionObserver 必须用 **callback ref** 模式：

```tsx
const observerRef = useRef<IntersectionObserver | null>(null);
const sentinelRef = useCallback((node: HTMLDivElement | null) => {
  if (observerRef.current) {
    observerRef.current.disconnect();
    observerRef.current = null;
  }
  if (!node) return;
  const observer = new IntersectionObserver(callback, options);
  observer.observe(node);
  observerRef.current = observer;
}, [stableCallback]);
```

callback ref 在 node 挂载/卸载时由 React 自动调用，天然管理 observer 生命周期。`useRef + useEffect` 模式只适合**稳定渲染**的元素。

**Why 这很重要**：useRef 不触发重渲染，effect 只在 deps 变化时跑。deps 稳定（典型 useCallback 空 deps）+ ref 节点延迟出现 → effect 永不重跑 → observer 永不接入。这个 bug 静默且难调试——typecheck/lint/e2e 都不会提示，只在「数据加载后用户滚动」时表现为「不会自动加载更多」，与产品文档预期完全一致看不出问题。

**Evidence**: `apps/web/app/history/page.tsx` 初版用 useRef + useEffect[loadMore]，sentinel 仅在 list 状态渲染，effect 错过节点首次出现，observer 不接入。改为 callback ref 后立即正常。`use-photos-infinite.ts` 不踩此坑因为它配套的 sentinel 是稳定渲染的虚拟列表项。

### [2026-05-08] Playwright page.route glob 中 `?` 是单字符通配符，匹配 query string 必须用 `*`

<!-- tags: playwright, page-route, glob, minimatch, mock, query-string, e2e, bug -->

**Scenario**: 想 mock 后端列表请求 `GET /api/daily?page=1&pageSize=20`，写成 `page.route("**/api/daily?**", handler)`。看似自然，但 minimatch glob 中 `?` 是「恰好一个字符」通配符（不是字面问号），实际匹配「`/api/daily` 后跟一个任意字符再跟任意路径段」，对真实 URL 不命中 → handler 不触发 → 测试看到的是真实后端响应（或网络错误）。

**Lesson**:
- 通配 query string 用 `*`：`page.route("**/api/daily*", handler)` ✅
- 不要用 `?` 当字面问号
- 复杂匹配用 RegExp：`page.route(/\/api\/daily\?/, handler)`（注意正则中 `?` 也要转义）

**Why 这很重要**：minimatch/picomatch 与 shell glob 通配符语义不同（shell `?` 也是单字符通配但不常见），URL 含 `?` 引入二义性，测试中难发现——失败表现是「mock 没生效，调用了真实后端」而不是显式错误。

**Evidence**: 本任务设计阶段 plan-reviewer 第 2 轮审查发现并指出，修正为 `**/api/daily*` 后红队 Playwright e2e 3/3 PASS。

### [2026-05-09] drizzle async transaction 在 better-sqlite3 driver 上抛 `Transaction function cannot return a promise`

<!-- tags: drizzle, better-sqlite3, transaction, sync, async, sqlite, orm, bug, multi-step-update -->

**Scenario**: 写多步 UPDATE 包事务规避并发竞态时，按 PostgreSQL/Postgres-drizzle 的经验顺手写 `await db.transaction(async (tx) => { await tx.update(...).set(...).where(...); ... })`，TS 类型校验通过、看起来合理，但运行时抛 `TypeError: Transaction function cannot return a promise`，HTTP 返回 500。**奇怪的是**：错误抛出**前**事务里的 UPDATE 已经成功执行（DB 状态正确），只在最后 commit 阶段抛错——给"代码逻辑没问题，只是 hono 反映 500"的错觉，难定位。

**Lesson**:
- `better-sqlite3` 的 `transaction()` API **严格同步**（库设计），drizzle 在该 driver 上原样转发，async callback 返回 Promise → 抛错
- 必须用 drizzle 的同步 `.run()` API + sync 回调：
  ```ts
  // ❌ 错（在 better-sqlite3 上）
  await db.transaction(async (tx) => {
    await tx.update(schema.x).set({...}).where(...);
    await tx.update(schema.y).set({...}).where(...);
  });

  // ✅ 对
  db.transaction((tx) => {
    tx.update(schema.x).set({...}).where(...).run();
    tx.update(schema.y).set({...}).where(...).run();
  });
  ```
- 单步 `await tx.insert(...).values(...)`（如 `scan-storage.ts:248`）能跑通是因为 callback 返回的 Promise 在 commit 前 microtask 内可能已 resolve，但**多步 await 之间事件循环让步必然爆**——所以"以前能跑"不代表新写也能跑

**Why 这很重要**：迁移自 PostgreSQL 的 drizzle 习惯（PG driver 支持 async tx）+ TypeScript 类型不报错 → 误以为通用 → 100% 概率运行时炸。debug 困难因为部分 SQL 已成功（DB 改了），错误冒出来是 commit 阶段非具体业务逻辑。

**Evidence**: `apps/backend/src/routes/bursts.ts` PATCH `/api/bursts/:id/representative` 三步 UPDATE 包事务校验代表归属——首版 async callback 测试时 DB 改对了但接口返回 500，红队 16/24 用例 fail；改为 sync 回调 + `.run()` 后 67/67 PASS。同步修了 `apps/backend/src/jobs/analyze-photo.ts:calibrateBurstRepresentative` 同模式问题。
