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
