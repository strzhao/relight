# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

拾光 (Relight) — AI 驱动的照片管理应用。自动扫描本地/远程存储源的图片，通过 AI 视觉模型分析照片的美学评分、标签、构图、色彩、情感等维度，每日精选最佳照片。

目标用户：中文用户。

## 技术栈

- **Monorepo**: pnpm workspaces + Turborepo
- **后端**: Hono (Node.js) + BullMQ + Redis + SQLite (better-sqlite3 + Drizzle ORM)
- **前端**: Next.js 15 (App Router) + React 19 + Tailwind CSS v4 + Radix UI
- **共享包**: `@relight/shared` (types, Zod schemas, API 路由常量)
- **工具链**: TypeScript 5.8, Biome (format + lint), Vitest, Playwright (e2e)

## 环境要求

- Node.js ≥ 20，pnpm ≥ 10
- Redis（BullMQ 必需）
- 关键环境变量（见 `.env.example`）：`STORAGE_ROOT`（照片根目录）、`REDIS_URL`、`DATABASE_PATH`、`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_VISION_MODEL`。AI 默认指向本地 `http://127.0.0.1:8001/v1`（qwen 兼容服务）

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

# 前端专属
pnpm --filter @relight/web dev             # 启动前端 (next dev --turbopack -p 3001)
```

**注意**：`pnpm dev` 启动的是 API + Web，不会启 Worker。要让扫描/分析/精选任务真正跑起来，需要单独跑 `pnpm --filter @relight/backend workers`。

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
packages/shared/ # 共享类型、Zod Schema、API 路由常量
```

`packages/shared` 是前后端的契约层 — `API_ROUTES`、所有 DTO 类型 (`Photo`, `DailyPick`, `Tag`, `AdminStats` 等) 和 Zod 校验 Schema 都在这里定义。修改 API 契约时必须先更新 shared 包。

### 后端架构 (apps/backend)

**入口**: `src/index.ts` → 启动 `@hono/node-server`，监听 `config.port` (默认 3000)，启动时注册每日精选定时任务（每天北京时间 6:00 AM）。
**应用工厂**: `src/app.ts` 的 `createApp()` 组装所有路由，测试可直接调用无需网络。

**路由** (`src/routes/`): 每个文件导出一个 `new Hono()` 子路由:
- `photos.ts` — 照片列表 (分页/标签过滤/排序)、详情 (JOIN 标签+分析+存储源)、缩略图
- `daily.ts` — 每日精选：查询最新精选照片（支持日期参数）、手动触发精选任务
- `scan.ts` — 触发扫描 (POST 入队)、扫描状态查询
- `admin.ts` — 管理后台 API: 综合统计、队列状态、健康检查、分页分析列表
- `tags.ts`, `settings.ts`, `health.ts` — 辅助路由

**异步任务系统** (`src/jobs/` + `src/workers/`):
- 三个 BullMQ 队列：`scan-storage`、`analyze-photo`、`daily-selection`
- Worker 进程 (`src/workers/index.ts`) 独立于 API 服务运行
- 扫描流程 (`scan-storage.ts`): 增量扫描 — 用 mtime+size 快速跳过未变更文件，仅对新文件/修改文件做 SHA256 + 缩略图生成，最后入队 analyze-photo
- 分析流程 (`analyze-photo.ts`): 读文件 base64 → 调 AI 视觉模型 → 解析 JSON 响应 → 写入 tags/photoTags/photoAnalyses（幂等设计，重复分析会 UPDATE 而非 INSERT）
- 精选流程 (`daily-selection.ts`): 两阶段 AI 流水线 — 阶段1 用文本模型从历史上今天的已分析照片中评选最佳（评分+标题+理由）→ 阶段2 用视觉模型为胜出照片生成叙事文案 → 写入 dailyPicks（pickDate 唯一约束，幂等覆盖）

**AI 层** (`src/ai/`):
- `client.ts` — OpenAI 兼容的 AI 客户端，使用 `openai` npm 包，禁用 qwen3.6 的 thinking 模式确保 JSON 输出在 `content` 字段
- `prompts/index.ts` — 从 `src/ai/prompts/` 加载 Prompt 文件，支持多版本 (`v1`, `v2`) 和子目录路径（如 `daily/select`, `daily/narrate`）
- `prompts/v1/` — 照片分析 Prompt（标签、评分、构图、色彩、情感）
- `prompts/v2/daily/select/` — 每日精选阶段1 Prompt：文本模型从候选照片中评选最佳
- `prompts/v2/daily/narrate/` — 每日精选阶段2 Prompt：视觉模型为胜出照片生成叙事文案
- `response-parser.ts` — 从 AI 响应提取 ```json 代码块 → Zod 校验 → 失败时容错恢复 (partial merge 默认值)；支持多种解析策略（严格模式/宽松模式）、JSON 修复（补全括号、移除尾部逗号）、重复键去重
- `evaluation/evaluator.ts` — 5 维度 100 分制自动评分（格式合规/标签准确/描述相关/评分合理/覆盖完整），纯规则无 AI 依赖

**存储适配器** (`src/storage/`):
- `interface.ts` — `IStorageAdapter` 接口: listFiles, getFileBuffer, getMimeType, getMetadata, computeFileHash
- `local.ts` — 本地文件系统实现，支持图片+视频格式，手动解析 EXIF 提取 DateTimeOriginal
- `index.ts` — 工厂函数 `createStorageAdapter(type)`，目前仅实现 local，SMB/WebDAV 待扩展

**数据库** (`src/db/`):
- `schema.ts` — Drizzle SQLite schema: storageSources, photos, tags, photoTags (复合主键), photoAnalyses (JSON 列存储复杂分析), dailyPicks, scanLogs, settings (key-value)
- `index.ts` — better-sqlite3 初始化，WAL 模式，外键开启

**配置** (`src/lib/config.ts`): 所有环境变量集中管理，带默认值。AI 服务默认 `http://127.0.0.1:8001/v1`（本地部署的 qwen 兼容服务）。

**HEIC 支持** (`src/lib/heic.ts`): 通过 `heic-decode` (WASM，纯 JS，无原生依赖) 将 HEIC/HEIF 解码为 RGBA 像素数据，再经 sharp resize + JPEG 编码。导出 `isHeicFile(filePath)` 和 `heicFileToJpeg(buffer, options?)` / `convertHeicToJpeg(buffer, options?)`。macOS 上 sharp 预编译的 libvips 不包含 HEIC 解码支持，因此选择 heic-decode 而非依赖 sharp。

**缩略图生成** (`src/lib/thumbnail.ts`): 800px max (`fit: "inside"`)，quality 85，HEIC 文件先经 heic-decode 解码。输出统一 `.jpg` 扩展名。

**CLI 工具** (`src/cli/`):
- `evaluate.ts` — 对 AI 响应文件运行评估器，退出码 0=通过 1=未通过
- `e2e-verify.ts` — 端到端验证 AI 分析全链路（单张照片）
- `repair-heic.ts` — 修复已有 HEIC 照片的缩略图（thumbnailPath IS NULL 且扩展名为 heic/heif）

### 前端架构 (apps/web)

- Next.js 15 App Router，Tailwind CSS v4，组件使用 `@/components/ui/` 下的 Radix UI 封装
- **客户端 API**: `lib/api.ts` — 浏览器端 fetch 包装，`NEXT_PUBLIC_API_URL` 指向后端
- **服务端 API**: `lib/admin-data.ts` — RSC 中 `serverFetch<T>()`，`cache: "no-store"` 保证数据实时
- **页面**: 首页 `/` (`DailyHero` 组件 — 展示今日精选照片+叙事文案), `/photos`, `/photos/[id]`, `/history`, `/settings`, `/admin` (仪表盘)
- **管理后台**: `/admin` 仪表盘 + `/admin/photos` + `/admin/queues` + `/admin/health` 子页面

### 数据流

```
存储源 → scan-storage job → 发现新文件 → 生成缩略图 → INSERT photos
                                    ↓
                           入队 analyze-photo job
                                    ↓
                        读文件 → base64 → AI 视觉模型
                                    ↓
                   解析 JSON → upsert tags / photoTags / photoAnalyses
                                    ↓
                        daily-selection job (每天早 6:00 定时)
                                    ↓
                   阶段1: 文本模型评选 (从历史上今天照片中选最佳)
                                    ↓
                   阶段2: 视觉模型叙事 (为胜出照片生成叙事文案)
                                    ↓
                          每日精选 → dailyPicks (pickDate 唯一)
                                    ↓
                         前端首页 DailyHero 组件展示
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
