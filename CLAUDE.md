# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

拾光 (Relight) — AI 驱动的照片管理应用。自动扫描本地/远程存储源的图片，通过 AI 视觉模型分析照片的美学评分、标签、构图、色彩、情感等维度，每日精选最佳照片。

目标用户：中文用户。

每日精选壁纸企业微信群推送（每天北京时间 10:00 自动推送横版 + 手机竖版 + mac 控制中心配置 webhook 与启用开关 + 测试发送）。

每日视频自动化（每天北京时间 10:00 cron 跑 video-discovery 做主题发现——旅行 / 人物成长线；命中主题才 spawn `claude -p` 调 memory-video skill 生成 1080p vlog，落盘 + 写 videos/videoUsages 表 + 企业微信推送封面与详情链接；无主题静默跳过，质量优先、非每日必出；主题发现对 trip/person 双分支做对称去重（completed 永久 + failed 7 天冷却，settings `video.skipPersonIds` 可跳过脏聚类）；claude -p 超时默认 45 分钟（env `VIDEO_SPAWN_TIMEOUT_MS` 覆盖）。

## 技术栈

- **Monorepo**: pnpm workspaces + Turborepo
- **后端**: Hono (Node.js) + BullMQ + Redis + SQLite (better-sqlite3 + Drizzle ORM)
- **前端**: Next.js 15 (App Router) + React 19 + Tailwind CSS v4 + Radix UI
- **共享包**: `@relight/shared` (types, Zod schemas, API 路由常量)
- **工具链**: TypeScript 5.8, Biome (format + lint), Vitest, Playwright (e2e)

## 环境要求

- Node.js ≥ 20，pnpm ≥ 10
- Redis（BullMQ 必需）
- ffmpeg ≥ 4.0（macOS: `brew install ffmpeg`）— 视频缩略图、关键帧抽取必需；缺失时视频走"占位降级"路径
- Whisper（可选）— 视频字幕转录，默认指向 `/Users/stringzhao/workspace/martin/`，可通过 `WHISPER_PYTHON` / `WHISPER_SCRIPT` env 覆盖；未启用时视频分析跳过转录
- 关键环境变量（见 `.env.example`）：`STORAGE_ROOT`（照片根目录）、`REDIS_URL`、`DATABASE_PATH`、`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_VISION_MODEL`。AI 默认指向本地 `http://127.0.0.1:8001/v1`（qwen 兼容服务）
- 人脸识别（可选）：ONNX Runtime + SCRFD-2.5G + ArcFace MobileFaceNet（共 ~16MB 模型权重）。首次启用前跑 `pnpm --filter @relight/backend models:download` 把权重下载到 `apps/backend/assets/models/`（不入版本控制）。模型 license 为学术 / non-commercial，仅适用于个人/家庭相册场景。模型缺失时 `detect-faces` worker 自动跳过，不阻塞主流程。

## 常用命令

```bash
pnpm dev              # 并行启动 backend + web (turbo dev)
pnpm build            # 构建所有包
pnpm lint             # Biome 检查 (biome check .)
pnpm format           # Biome 自动修复 (biome check --write .)
pnpm typecheck        # TypeScript 类型检查
pnpm test             # 运行全部 Vitest 测试
pnpm test:watch       # Vitest watch 模式
pnpm test:e2e         # Playwright e2e 测试
pnpm db:push          # 推送 Drizzle schema (根级快捷，等价于 --filter backend)
pnpm db:studio        # 打开 Drizzle Studio

# 后端专属
pnpm --filter @relight/backend dev         # 启动 API (tsx watch src/index.ts)
pnpm --filter @relight/backend workers     # 启动 Worker 进程（独立于 API，处理 BullMQ 队列）
pnpm --filter @relight/backend build       # tsup 打包
pnpm --filter @relight/backend start       # 跑生产构建产物
pnpm --filter @relight/backend tsx src/cli/backfill-media-type.ts  # 历史视频数据回填 mediaType / durationSec
pnpm --filter @relight/backend tsx src/cli/detect-bursts.ts        # 历史照片连拍组回填（识别已有照片中的连拍关系）
pnpm --filter @relight/backend backfill:daily-picks --dry-run       # 演练：列出历史缺失的每日精选日期（加 --yes 执行、--enqueue 入队）
pnpm --filter @relight/backend backfill:gallery --dry-run           # 演练：列出待回填画廊的天数/视频（加 --yes 执行上传 COS + 推 manifest 到 VPS，--limit 限量）
pnpm --filter @relight/backend models:download                     # 下载人脸识别 ONNX 模型权重（~16MB）

# 前端专属
pnpm --filter @relight/web dev             # 启动前端 (next dev --turbopack -p 3001)
```

**注意**：`pnpm dev` 启动的是 API + Web，不会启 Worker。要让扫描/分析/精选任务真正跑起来，需要单独跑 `pnpm --filter @relight/backend workers`。

## Worker 进程管理

Worker 进程负责处理 BullMQ 队列（扫描/分析/精选），独立于 API 服务运行。日常通过 PM2 管理：

```bash
pnpm workers:start    # 启动 worker（由 PM2 守护，崩溃自动重启）
pnpm workers:stop     # 停止 worker
pnpm workers:reload   # 零停机热重载（代码改动后使用）
pnpm workers:logs     # 查看最近 100 行日志
pnpm workers:status   # 查看进程状态
```

配置文件：`ecosystem.config.cjs`（仓库根），使用 `--import tsx` 直接运行 TypeScript 源码，无需构建。

前台调试（不推荐生产）：`pnpm --filter @relight/backend workers`

Mac 控制中心（ControlCenter.swift）已接通 GUI 触发：启动/停止/重启 3 按钮调用 `POST /api/runtime/workers/{start,stop,reload}`，按钮 disabled 状态由 `workers.status` 派生，操作前弹二次确认。日志页（LogsPage.swift）5s 轮询 `GET /api/runtime/workers/logs?lines=200` 展示 stdout/stderr；设置页（SettingsPage.swift）3-Section 重构——常规（API URL + 登录时自动启动 Toggle，Toggle 经 `MenuBarCommandBus.onAutoStartChange` → `AutostartManager.sync` 接通 SMAppService 注册）/ 后端配置（拉取 `GET /api/runtime/config` 只读展示 7 个 env 字段，aiApiKey 服务端掩码）/ 关于（版本号 + tagline）；macOS 标准 `Settings` scene 与菜单栏「设置...」按钮已移除，设置入口统一到控制中心设置页；报告页（ReportsPage.swift）列出最近 30 天 DailyPick 并支持一键触发精选。

**后端 API 进程也由 PM2 编排**：`ecosystem.config.cjs` 包含 `relight-api`（`src/index.ts`，max_memory_restart 1G）和 `relight-workers` 共 2 个条目，两者 env 均注入 `PATH` 以确保开机 resurrect 时 pnpm 可被正确解析。首次部署或配置变更后执行 `pm2 start ecosystem.config.cjs && pm2 save`，即可复用系统已有的 pm2 resurrect launchd 实现开机自启，无需再次运行 `pm2 startup`。

## Worktree 并行开发

用 `claude -w <name>` 创建 worktree 后，string-claude-code-plugin 会自动 install 依赖并触发本工程的 `postinstall` 钩子，自动生成 worktree 专属配置：

- 端口：`BACKEND_PORT = computePort(branch)`（4001-4999），`WEB_PORT = BACKEND_PORT + 500`（4501-5499）
- BullMQ prefix：`bull-<branch>`，与主仓库（`bull-main`）和其他 worktree 完全隔离
- 数据：`STORAGE_ROOT` / `DATABASE_PATH` 指向主仓库绝对路径（worktree 立刻可见真实数据）

worktree 里 `pnpm dev` 直接启动 backend + web；workers 用 `pnpm --filter @relight/backend workers`。

手动修复已有 worktree 配置：在 worktree 根目录跑 `pnpm worktree:setup`。

## 架构概览

### 三层 Monorepo

```
apps/backend/    # Hono API 服务 (默认 :3000)
apps/web/        # Next.js 前端 (默认 :3001)
apps/mac/        # SwiftUI macOS 壁纸 APP（独立 Xcode 工程，xcodebuild 构建）
packages/shared/ # 共享类型、Zod Schema、API 路由常量
```

`packages/shared` 是前后端的契约层 — `API_ROUTES`、所有 DTO 类型 (`Photo`, `DailyPick`, `Tag`, `AdminStats` 等) 和 Zod 校验 Schema 都在这里定义。也承载跨端复用的纯函数（如 `datetime.ts` 的 `formatPhotoCaptureTime` — web DailyHero 与 wallpaper footer 拍摄时刻 dateline 同源）。修改 API 契约时必须先更新 shared 包。

### 后端架构 (apps/backend)

**入口**: `src/index.ts` → 启动 `@hono/node-server`，监听 `config.port` (默认 3000)，启动时注册每日精选定时任务（每天北京时间凌晨 0:00）。
**应用工厂**: `src/app.ts` 的 `createApp()` 组装所有路由，测试可直接调用无需网络。

**路由** (`src/routes/`): 每个文件导出一个 `new Hono()` 子路由:
- `photos.ts` — 照片列表 (分页/标签过滤/排序)、详情 (JOIN 标签+分析+存储源)、缩略图
- `daily.ts` — 每日精选：查询最新精选照片（支持日期参数）、手动触发精选任务、`GET /:pickDate/wallpaper` 按尺寸实时合成杂志版壁纸（支持 `width`/`height` query param，磁盘缓存命中时直接返回）、`GET /:pickDate/wallpaper-video` 壁纸视频下载地址（`wallpaper_video_landscape_url` 非空 → 302 跳转 COS；空/记录不存在 → 404 JSON error）
- `scan.ts` — 触发扫描 (POST 入队)、扫描状态查询
- `admin.ts` — 管理后台 API: 综合统计、队列状态、健康检查、分页分析列表
- `bursts.ts` — 连拍组 API：`GET /api/bursts/:id/members`（组内成员列表）、`PUT /api/bursts/:id/representative`（手动切换代表）
- `tags.ts`, `settings.ts`, `health.ts` — 辅助路由

**异步任务系统** (`src/jobs/` + `src/workers/`):
- BullMQ 队列：`scan-storage`、`analyze-photo`、`daily-selection`、`detect-faces`、`daily-push`、`daily-video`、`wallpaper-video`（动态视频壁纸：显式 `attempts: 1` 覆盖全局重试，失败当日回退静态）
- Worker 进程 (`src/workers/index.ts`) 独立于 API 服务运行
- 扫描流程 (`scan-storage.ts`): 增量扫描 — 用 mtime+size 快速跳过未变更文件，仅对新文件/修改文件做 SHA256 + 缩略图生成，最后入队 analyze-photo；扫描结束后调用 `detectBursts` 识别连拍组（时间窗口 ≤3s + dHash 汉明距离 ≤10），写入 `bursts` 表并标记每组代表
- 分析流程 (`analyze-photo.ts`): 读文件 base64 → 调 AI 视觉模型 → 解析 JSON 响应 → 写入 tags/photoTags/photoAnalyses（幂等设计，重复分析会 UPDATE 而非 INSERT）；分析完成后调用 `calibrateBurstRepresentative` 在组内竞争代表位（选评分最高者）
- 精选流程 (`daily-selection.ts`): 多条目并行流水线 — `buildCandidatePool`（4 源混采 + 可选 recent 第 5 源 + 跨表去重 + 主力源美学下限 `minAestheticScorePrimary` 默认 ≥7.0、fillUp ≥7.5；recent 源 = 近 `DAILY_RECENT_SOURCE_DAYS`（默认 30）天拍摄、同美学门槛、源内按美学分竞争、quota 保底 1 席，`DAILY_RECENT_SOURCE` 默认关——平权改版后近期照片在源内 aes 竞争中被历史同月高分照挤出 LIMIT，dry run 验证 recent 源使近 30 天照片从 0.25 → 6.0 席/天，真实代码 A/B 见 `src/cli/dry-run-real-pool.ts`）→ **select AI 评选阶段**（`runSelectStage`：文本模型从候选摘要重排 hero，`weightedScore` 降序为兜底；5 路 fallback 保序：`dailySelectEnabled===false`/候选<2 零 AI/抛错/解析失败/越界）→ pLimit 并发为每张独立执行 narrate(vision)+select members(text)，生成各自 title/narrative/members；db.transaction 批量 DELETE+INSERT 写入 `dailyPickEntries`（幂等覆盖，UNIQUE(dailyPickId,rank)）；entries[0] 同步作为 dailyPicks 主记录；阶段3 调 Satori 合成杂志版 DailyHero 壁纸（5K 16:9，基于 entries[0]）落盘，路径写入 `dailyPicks.composedImagePath`，并追加合成手机竖版壁纸（1290×2796，B 方案全屏照片+底部渐变压白字，cacheKey `1290x2796` 与路由/推送三方闭合，独立 try/catch 不阻塞主流程）；**阶段4 动态视频壁纸**（`DAILY_WALLPAPER_VIDEO` 默认关）：开关开 ∧ hero 非视频 ∧ composedImagePath 非空 → 链式 one-off enqueue `wallpaper-video` job（独立 try/catch 旁路，失败不影响精选）→ 串行「横生成→横转码→竖生成→竖转码」（spawn honeydo 双锚定伪循环 `--first-frame`/`--last-frame` 同图，sharp 预裁剪对齐生成画布 1280×704 / 704×1216；**prompt 解析链**：`daily_picks.motion_prompt`（narrate vision 按画面内容生成的专属运动描述，30-50 字+Audio 环境音指引）→ 无则按有无人脸分层默认 `WALLPAPER_VIDEO_PROMPT_PERSON/SCENE`（2026-09-13 修订：废除全场景单一收敛句式）；横转 HEVC hvc1 .mov 1920×1080 带音轨 aac 128k +faststart 供 Aerial 注入（双轨均保留音轨），竖转 H.264 mp4 704×1216 带音轨 +faststart 供画廊；**Remotion 横版两栏布局**（视频居左 contain + 右侧文字栏，几何/字号/配色逐字对齐静态模版 dailyHeroJSX，composition 1920×1080=Aerial 原生 16:9）+ 竖版全屏铺底维持 v2；footer 拍摄时刻与 web/静态壁纸同源 `formatPhotoCaptureTime`（后端算好 `captureDateline` 传入 props，takenAt 缺失 footer 不渲染））→ COS 上传（回执非空串才写 `daily_picks.wallpaper_video_landscape_url/portrait_url` 两列）→ `syncDayToGallery` 重建 manifest（视频字段条件展开：DB 列空 → JSON 字段缺省）；手动重跑 `npm run wallpaper-video:rerun -- --pickDate=YYYY-MM-DD`；**候选池排序**：`weightedScore = aestheticScore`（2026-09-04 起年代完全平权，无年份限制、无 ageBonus——此前乘法 1.6× → 加法封顶 +0.3 → 完全移除；新照片与老照片同台，只比美学质量）；**家人主角**：候选摘要与 narrate 均注入 `peopleNicknames`（画面家人称呼），select prompt 置最高优先级规则「家人出镜优先于纯宠物/风景」；**定时任务自愈**：`daily-selection-cron` job 触发时先按升序补跑最近 `DAILY_AUTO_HEAL_DAYS`（默认 7）天缺失的 dailyPicks（内层 job name=`auto-heal`，单日失败不中断），再跑今天——宕机几天可自动恢复，超大历史缺口仍用手动 `backfill:daily-picks` CLI（`--enqueue` + worker 慢慢消化）

**AI 层** (`src/ai/`):
- `client.ts` — OpenAI 兼容的 AI 客户端，使用 `openai` npm 包，禁用 qwen3.6 的 thinking 模式确保 JSON 输出在 `content` 字段
- `prompts/index.ts` — 从 `src/ai/prompts/` 加载 Prompt 文件，支持多版本 (`v1`, `v2`) 和子目录路径（如 `daily/select`, `daily/narrate`）
- `prompts/v1/` — 照片分析 Prompt（标签、评分、构图、色彩、情感）
- `prompts/v2/daily/select/` — 每日精选阶段1 Prompt：文本模型从候选照片中评选最佳
- `prompts/v2/daily/narrate/` — 每日精选阶段2 Prompt：视觉模型为胜出照片生成叙事文案 + `motionPrompt`（微动视频运动描述，30-50 字 + Audio 环境音指引，随 entries[0] 落 `daily_picks.motion_prompt` 供壁纸视频使用）
- `response-parser.ts` — 从 AI 响应提取 ```json 代码块 → Zod 校验 → 失败时容错恢复 (partial merge 默认值)；支持多种解析策略（严格模式/宽松模式）、JSON 修复（补全括号、移除尾部逗号）、重复键去重
- `evaluation/evaluator.ts` — 5 维度 100 分制自动评分（格式合规/标签准确/描述相关/评分合理/覆盖完整），纯规则无 AI 依赖

**存储适配器** (`src/storage/`):
- `interface.ts` — `IStorageAdapter` 接口: listFiles, getFileBuffer, getMimeType, getMetadata, computeFileHash
- `local.ts` — 本地文件系统实现，支持图片+视频格式，手动解析 EXIF 提取 DateTimeOriginal
- `index.ts` — 工厂函数 `createStorageAdapter(type)`，目前仅实现 local，SMB/WebDAV 待扩展

**数据库** (`src/db/`):
- `schema.ts` — Drizzle SQLite schema: storageSources, photos（含 burstId/isBurstRepresentative/burstRank 三列）, tags, photoTags (复合主键), photoAnalyses (JSON 列存储复杂分析), dailyPicks, scanLogs, settings (key-value), **bursts**（连拍组：id, representativeId, memberCount, detectedAt）, **dailyPickEntries**（每日精选条目：id, dailyPickId, rank, photoId, title, narrative, score, members JSON, createdAt；UNIQUE(dailyPickId, rank) + idx_dpe_pick_rank 索引）
- `index.ts` — better-sqlite3 初始化，WAL 模式，外键开启

**配置** (`src/lib/config.ts`): 所有环境变量集中管理，带默认值。AI 服务默认 `http://127.0.0.1:8001/v1`（本地部署的 qwen 兼容服务）。

**HEIC 支持** (`src/lib/heic.ts`): 通过 `heic-decode` (WASM，纯 JS，无原生依赖) 将 HEIC/HEIF 解码为 RGBA 像素数据，再经 sharp resize + JPEG 编码。导出 `isHeicFile(filePath)` 和 `heicFileToJpeg(buffer, options?)` / `convertHeicToJpeg(buffer, options?)`。macOS 上 sharp 预编译的 libvips 不包含 HEIC 解码支持，因此选择 heic-decode 而非依赖 sharp。

**RAW/DNG 支持** (`src/lib/raw.ts`): 通过 `dcraw -e -c` 提取 RAW 文件（.dng）中的相机内嵌 JPEG 预览，不进行 RAW 冲印，速度快（< 1 秒）。导出 `extractRawPreview(filePath)` 和 `RAW_EXTENSIONS`。dcraw 需通过 `brew install dcraw` 安装，路径 `/opt/homebrew/bin/dcraw`。analyze-photo 和 daily-selection 的 processSingleEntry 均通过此模块处理 DNG 文件，避免 sharp 无法解码 RAW 格式的降级。

**缩略图生成** (`src/lib/thumbnail.ts`): 800px max (`fit: "inside"`)，quality 85，HEIC 文件先经 heic-decode 解码。输出统一 `.jpg` 扩展名。

**MIME 嗅探** (`src/lib/mime.ts`): magic byte 优先的图片 content-type 探测，导出 `sniffImageContentType(buffer, fallback)`。解决 iPhone 同步把 JPEG 字节命名为 .HEIC 的错配 — original/raw 端点 content-type 改为「字节优先、扩展名兜底」，避免浏览器按错误的 image/heic 渲染导致裂图。纯函数、零依赖、bounds-check 短 buffer 安全降级。

**壁纸合成器** (`src/lib/wallpaper/`):
- `composer.ts` — 核心合成逻辑：读取精选照片 + 叙事文案，调 Satori 渲染 JSX 模板为 SVG，再经 resvg-js 光栅化为 PNG，最终 sharp 压缩为高质量 JPEG。默认输出 5K 16:9（5120×2880），支持按目标屏幕尺寸（`width`/`height`）动态缩放，结果落盘到 `STORAGE_ROOT/daily-composed/` 目录。竖版分支（`width < height`）走 sharp/HEIC 精确 cover 预裁（不带 ×1.2），横版保持 inside 余量不变。
- `template.tsx` — Satori JSX 模板（`jsxImportSource = "satori/jsx"`）：横版 `dailyHeroJSX`（杂志版排版：大图铺底 + 渐变遮罩 + 标题 Fraunces + 叙事文案 Noto Serif SC + footer 拍摄时刻 dateline，`takenAt` 有效时显示「拍摄于 {日期} {时刻} · {N} 年前」，与 web 同源 `formatPhotoCaptureTime`；`takenAt` 缺失 footer 留白）；竖版 `portraitHeroJSX`（B 方案：全屏 `<img>` 撑满 + absolute 底部渐变压暗 + 暖纸白字层，`scale = min(W/1290, H/2796)` 双轴约束，横版 `scale = W/1800` 不动）。
- `colors.ts` — 从照片主色调提取渐变色，增强视觉层次。
- 字体资产放在 `apps/backend/assets/fonts/`（Fraunces `.ttf` + Noto Serif SC `.otf`），tsup 构建时通过 `copyPublicDir` 自动复制到 `dist/assets/`。
- `tsup.config.ts` — 后端独立构建配置，处理 Satori JSX 转换和字体资产复制。

**VPS 画廊同步** (`src/lib/cos/` + `src/lib/gallery/`)：把每日精选 + 主题视频产物推送公网画廊（gallery.stringzhao.life，Caddy 静态托管 `apps/gallery/` 单页站）。架构为**推送式同步**——后端产物上传腾讯云 COS（公有读）→ 生成 manifest → scp+ssh mv 原子推到 VPS，静态站拉 manifest 渲染。画廊前端（`apps/gallery/`）视频单元支持真全屏观看（原生全屏 API + 横屏引导，requestFullscreen 优先、iOS webkit 兜底、双 API 均缺降级横屏提示 toast）。
- `cos/upload.ts` — COS 上传 lib（cos-nodejs-sdk-v5，重试 3 次；容错契约：失败返回空串不 throw，画廊是旁路不阻塞主流程）
- `gallery/manifest.ts` — `buildManifest()` 全量读 DB → manifest（COS key 约定 `relight/daily/<date>/...` + `relight/videos/<themeKey>/...`；composedImagePath=null 边界跳过；durationSec 正整数门过滤无效视频）
- `gallery/sync.ts` — `pushManifest`（本地写 tmp.json → `scp` 上传 → `ssh mv` 原子覆盖 VPS manifest.json，shellQuote 单引号转义防注入）+ `syncDayToGallery`/`syncVideoToGallery`（全部 `Promise<void>`，try/catch 旁路容错，失败 console.warn + job.log 不阻塞精选/视频主流程；调用方在 daily-selection 阶段 3.5、daily-video 步骤 4.5 各自独立 try/catch 包裹）
- 凭据配置见 `config.cos`/`config.gallery`（凭据命名兼容：优先 `TENCENTCLOUD_SECRET_ID/SECRET_KEY/APPID/REGION`，fallback `COS_*`；bucket = `little-bee-assets-${APPID}`；缺失走默认值，本机开发画廊同步 console.warn 跳过）
- 画廊卡下载（apps/gallery）：照片/视频/壁纸三类卡统一下载按钮——iOS 走 Web Share API 弹系统分享面板存相册（微信/企微内置浏览器检测 MicroMessenger UA 弹「在 Safari 中打开」引导遮罩；fetch 失败兜底开直链）；跨域 fetch 依赖桶 CORS，由 `cos:cors` CLI 一次性配置

**CLI 工具** (`src/cli/`):
- `evaluate.ts` — 对 AI 响应文件运行评估器，退出码 0=通过 1=未通过
- `e2e-verify.ts` — 端到端验证 AI 分析全链路（单张照片）
- `repair-heic.ts` — 修复已有 HEIC 照片的缩略图（thumbnailPath IS NULL 且扩展名为 heic/heif）
- `backfill-thumbnails.ts` — 补救 `thumbnail_path IS NULL` 的历史照片缩略图，复用 generateThumbnail，支持 `--dry-run`/`--limit`/`--media-type`（script: `backfill:thumbnails`）
- `backfill-daily-picks.ts` — 补跑历史缺失的每日精选（检测 dailyPicks 表缺失日期，逐日回填；`--dry-run` 演练 / `--yes` 执行 / `--enqueue` 入队；默认 `--from=最早照片日`、`--to=今日`；复用 worker pickDate 覆盖，进程内顺序或 BullMQ 入队）（script: `backfill:daily-picks`）
- `backfill-gallery.ts` — 历史回填画廊同步（遍历已有 dailyPicks/videos，复用 `uploadDayAssets`/`uploadVideoAssets` 上传 COS + 最后统一刷一次 manifest 推 VPS；`--dry-run` 演练 / `--yes` 执行 / `--limit` 限量；资源上传失败才 exit 2，manifest 推送失败仅 warn 不致命）（script: `backfill:gallery`）
- `setup-cos-cors.ts` — 一次性配置 COS 桶 CORS 放行画廊站跨域 fetch（幂等 getBucketCors → mergeCorsRules 合并只追加不删除、单/复数键双兼容 + 重复规则去重自愈 → putBucketCors；默认 dry-run / `--yes` 执行；退出码 0 成功含幂等 skip、1 凭据缺失、2 API 失败）（script: `cos:cors`）

### 前端架构 (apps/web)

- Next.js 15 App Router，Tailwind CSS v4，组件使用 `@/components/ui/` 下的 Radix UI 封装
- **客户端 API**: `lib/api.ts` — 浏览器端 fetch 包装，`NEXT_PUBLIC_API_URL` 指向后端
- **服务端 API**: `lib/admin-data.ts` — RSC 中 `serverFetch<T>()`，`cache: "no-store"` 保证数据实时
- **页面**: 首页 `/` (`DailyHero` 组件 — 展示今日 12 张精选 entries，左大图+右叙事+底部缩略图栅格，支持 ?entry=N URL 同步/键盘 ←/→ 切换/aria-selected；`CaptureDateline`（拍摄时刻「拍摄于 {日期} · {时刻} · {N} 年前」，与壁纸同源 `formatPhotoCaptureTime`，`takenAt` 缺失不渲染）渲染在右下角 `FolioFooter`（masthead 不再含 dateline；FolioFooter 仅 dateline 单行，原 `Vol. {year}` / `Relight Chronicle` 品牌印记已删精简）；entries=[] 时回退 HeroContentLegacy 旧版布局), `/photos`, `/photos/[id]`, `/history`, `/settings`, `/admin` (仪表盘)
- **管理后台**: `/admin` 仪表盘 + `/admin/photos` + `/admin/queues` + `/admin/health` 子页面

### 数据流

```
存储源 → scan-storage job → 发现新文件 → 生成缩略图 → INSERT photos
                                    ↓
                           入队 analyze-photo job
                                    ↓
        图片: 读文件 → base64 → AI 视觉模型
        视频: ffmpeg 抽帧（sprite）+ Whisper 转录（可选）→ 视频专属 prompt → AI 视觉模型
                                    ↓
                   解析 JSON → upsert tags / photoTags / photoAnalyses
                                    ↓
                        daily-selection job (每天凌晨 0:00 定时)
                                    ↓
                   候选池: 4 源混采 + 跨表去重 (daily_picks ∪ daily_pick_entries.members)
                          主力源美学下限 ≥7.0 / fillUp ≥7.5
                          4 源均无年份限制（今年照片可入选），weightedScore = aestheticScore
                          （2026-09-04 起年代完全平权，ageBonus 已移除）
                          第 5 源 recent（近 N 天拍摄，DAILY_RECENT_SOURCE 默认关）：
                          近期照片专源竞争，解决平权后新照片在 aes 竞争中出局（dry run 0.25→6.0 席/天）
                                    ↓
                   select 评选阶段: 文本模型重排 hero (runSelectStage, 5 路 fallback 保序)
                          候选摘要含「画面人物」(peopleNicknames)，prompt 规则「家人主角优先」
                                    ↓
                   pLimit 并发: 12 张 entries 各自 narrate(vision) + select members(text)
                          narrate 注入画面人物称呼（第一位=画面主角宜作「你」）
                                    ↓
                   db.transaction: DELETE + bulk INSERT dailyPickEntries (幂等)
                          entries[0] 同步写 dailyPicks 主记录
                                    ↓
                   阶段3: Satori 合成杂志版壁纸 (5K 16:9 JPEG 落盘, 基于 entries[0])
                          composedImagePath 写入 dailyPicks
                                    ↓
                   阶段4: 动态视频壁纸 (DAILY_WALLPAPER_VIDEO 默认关)
                          链式 enqueue wallpaper-video job → honeydo 微动化 hero 照片
                          （双锚定伪循环，横 1280×704 / 竖 704×1216 画布预裁剪）
                          → 横转 HEVC hvc1 .mov 1920×1080 / 竖转 H.264 mp4 704×1216
                          （双轨均带音轨 aac +faststart）→ COS 上传 → 写 daily_picks 两列 → 画廊同步
                          失败当日回退静态（旁路容错，不影响精选主流程）
                                    ↓
                   API: GET /api/daily/today → DailyPick { entries: DailyPickEntry[] }
                                    ↓
                   前端首页 DailyHero: 12 缩略图栅格 + 左大图/右叙事 + series strip
                                    ↓
              mac App: GET /api/daily/:pickDate/wallpaper?width=&height=
                       (按屏幕尺寸实时合成/缓存命中直接返回，设为系统壁纸)
                                    ↓
                   手机竖版 1290×2796: 阶段3 预生成缓存 + 企业微信推送追加竖版
                       (缓存优先/现场合成兜底，独立 try/catch 不阻断横版)
                                    ↓
              VPS 画廊（gallery.stringzhao.life，Caddy 静态托管，推送式同步）:
                  daily-selection 阶段 3.5（阶段 4 壁纸视频完成后经 syncDayToGallery 幂等重建）/
                  daily-video 步骤 4.5 → syncDayToGallery /
                  syncVideoToGallery（独立 try/catch 旁路）→ 产物上传腾讯云 COS（公有读；壁纸视频
                  key = `relight/wallpaper-videos/{pickDate}_landscape.mov` / `_portrait.mp4`，
                  manifest 视频字段条件展开——DB 回执列空则字段缺省）+
                  buildManifest → scp+ssh mv 原子推 manifest.json 到 VPS → 静态站拉 manifest
                  渲染 #/ #/history #/video/<id>（OKLCH 品牌色单页站）。daily-video 推送 URL
                  改用 `config.galleryPublicUrl + /#/video/<id>`（修原 localhost bug）。
                  历史回填走 `backfill:gallery` CLI。
```

## 设计体系

**色彩空间**: OKLCH（感知均匀）· **设计哲学**: 温润、克制、有机、清醒

### 核心色板

| 名称 | 用途 | CSS Token | OKLCH 值 |
|------|------|-----------|----------|
| Paper (纸) | 页面基底 | `--background` | `oklch(0.975 0.010 95)` |
| Ink (墨) | 正文/标题 | `--foreground` | `oklch(0.155 0.006 95)` |
| Mist (雾) | 卡片/分割 | `--secondary` | `oklch(0.935 0.002 95)` |
| Smoke (烟) | 描述/辅助 | `--muted-foreground` | `oklch(0.520 0.005 95)` |
| Sage (苔) | CTA/品牌 | `--primary` | `oklch(0.488 0.088 158)` |
| Amber (琥) | 警告 | `--warning`, `--score-mid` | `oklch(0.660 0.165 85)` |
| Vermillion (朱) | 错误/删除 | `--destructive` | `oklch(0.550 0.190 30)` |
| Sky (天) | 链接/信息 | `--info`, `--status-active` | `oklch(0.575 0.130 250)` |

**色相基线**: 无彩色 H=95（暖调），品牌 Sage H=158-160，Amber H=85，Vermillion H=30，Sky H=250

### 语义 Token

**评分** — `--score-high/bg` (苔绿)、`--score-mid/bg` (琥珀)、`--score-low/bg` (炭灰)
**任务状态** — `--status-waiting/active/completed/failed/delayed/paused`
**信息/警告** — `--info/fg/bg/border` (天蓝)、`--warning/fg` (琥珀)

### 使用规范

- 所有颜色必须通过 CSS 变量引用（`bg-primary`、`text-muted-foreground`），**禁止**硬编码 Tailwind 颜色值（`bg-green-500`、`text-blue-600` 等）
- 状态指示使用语义 Token：`bg-status-active`、`text-status-failed` 等
- 评分使用评分 Token：`text-score-high`、`bg-score-mid-bg` 等
- 新增语义 Token 需同步更新 `globals.css` 的 `:root`、`.dark`、`@theme inline` 三个位置
- 暗色模式通过 `.dark` class 触发，保持暖黑基底（H=95）+ 品牌色增亮

### 动效时序

| 交互 | 时长 |
|------|------|
| hover 反馈 | 100ms |
| 点击反馈 | 50ms |
| 复制确认 | 2s |
| 入场动画 | 400ms |
| 状态切换 | 200ms |

## 测试

- 单元/集成测试: `**/__tests__/*.test.ts` (Vitest)，workspace 配置在 `vitest.workspace.ts`
- E2E: `apps/web/__tests__/smoke.test.ts` (Playwright)
- 后端测试使用真实 SQLite 数据库 (better-sqlite3)，不 mock DB
- 运行单个测试文件: `pnpm vitest run path/to/test.test.ts`
- Acceptance 测试覆盖: API 契约、数据流、hash 去重、响应解析器、评估器、管理后台数据一致性等

## Git 规范

- Commit message 遵循 conventional commits (`@commitlint/config-conventional`)
- `.autopilot/` 目录下文件需多人共享，commit 时应包含
- pre-commit hook 通过 lint-staged 运行 Biome 自动格式化
