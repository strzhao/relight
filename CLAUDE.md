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

# 后端专属
pnpm --filter @relight/backend dev         # 启动后端 (tsx watch src/index.ts)
pnpm --filter @relight/backend db:push     # Drizzle 推送 schema 到 SQLite
pnpm --filter @relight/backend db:studio   # Drizzle Studio 管理界面

# 前端专属
pnpm --filter @relight/web dev             # 启动前端 (next dev --turbopack -p 3001)
```

## 架构概览

### 三层 Monorepo

```
apps/backend/    # Hono API 服务 (默认 :3000)
apps/web/        # Next.js 前端 (默认 :3001)
packages/shared/ # 共享类型、Zod Schema、API 路由常量
```

`packages/shared` 是前后端的契约层 — `API_ROUTES`、所有 DTO 类型 (`Photo`, `DailyPick`, `Tag`, `AdminStats` 等) 和 Zod 校验 Schema 都在这里定义。修改 API 契约时必须先更新 shared 包。

### 后端架构 (apps/backend)

**入口**: `src/index.ts` → 启动 `@hono/node-server`，监听 `config.port` (默认 3000)。
**应用工厂**: `src/app.ts` 的 `createApp()` 组装所有路由，测试可直接调用无需网络。

**路由** (`src/routes/`): 每个文件导出一个 `new Hono()` 子路由:
- `photos.ts` — 照片列表 (分页/标签过滤/排序)、详情 (JOIN 标签+分析+存储源)、缩略图
- `daily.ts` — 每日精选 (目前 stub)
- `scan.ts` — 触发扫描 (POST 入队)、扫描状态查询
- `admin.ts` — 管理后台 API: 综合统计、队列状态、健康检查、分页分析列表
- `tags.ts`, `settings.ts`, `health.ts` — 辅助路由

**异步任务系统** (`src/jobs/` + `src/workers/`):
- 三个 BullMQ 队列：`scan-storage`、`analyze-photo`、`daily-selection`
- Worker 进程 (`src/workers/index.ts`) 独立于 API 服务运行
- 扫描流程 (`scan-storage.ts`): 增量扫描 — 用 mtime+size 快速跳过未变更文件，仅对新文件/修改文件做 SHA256 + 缩略图生成，最后入队 analyze-photo
- 分析流程 (`analyze-photo.ts`): 读文件 base64 → 调 AI 视觉模型 → 解析 JSON 响应 → 写入 tags/photoTags/photoAnalyses（幂等设计，重复分析会 UPDATE 而非 INSERT）

**AI 层** (`src/ai/`):
- `client.ts` — OpenAI 兼容的 AI 客户端，使用 `openai` npm 包，禁用 qwen3.6 的 thinking 模式确保 JSON 输出在 `content` 字段
- `prompts/index.ts` — 从 `src/ai/prompts/v1/` 加载 system.txt + user.txt
- `response-parser.ts` — 从 AI 响应提取 ```json 代码块 → Zod 校验 → 失败时容错恢复 (partial merge 默认值)
- `evaluation/evaluator.ts` — 5 维度 100 分制自动评分（格式合规/标签准确/描述相关/评分合理/覆盖完整），纯规则无 AI 依赖

**存储适配器** (`src/storage/`):
- `interface.ts` — `IStorageAdapter` 接口: listFiles, getFileBuffer, getMimeType, getMetadata
- `local.ts` — 本地文件系统实现，支持图片+视频格式，手动解析 EXIF 提取 DateTimeOriginal
- `index.ts` — 工厂函数 `createStorageAdapter(type)`，目前仅实现 local，SMB/WebDAV 待扩展

**数据库** (`src/db/`):
- `schema.ts` — Drizzle SQLite schema: storageSources, photos, tags, photoTags (复合主键), photoAnalyses (JSON 列存储复杂分析), dailyPicks, scanLogs, settings (key-value)
- `index.ts` — better-sqlite3 初始化，WAL 模式，外键开启

**配置** (`src/lib/config.ts`): 所有环境变量集中管理，带默认值。AI 服务默认 `http://127.0.0.1:8001/v1`（本地部署的 qwen 兼容服务）。

**HEIC 解码器** (`src/lib/heic-decoder.ts`): 通过系统 `heif-convert` CLI 将 HEIC/HEIF 文件转换为 JPEG。`createHeicDecoder()` 返回 `HeicDecoder` 对象，`available` 属性（memoized）检测 CLI 是否安装，`convertToJpeg(input, output)` 执行带 30s 超时的两步转换（HEIC -> 临时 JPEG -> 目标路径）。`checkAvailability()` 在进程生命周期内最多执行一次，结果 memoized。

**CLI 工具** (`src/cli/`):
- `evaluate.ts` — 对 AI 响应文件运行评估器，退出码 0=通过 1=未通过

### 前端架构 (apps/web)

- Next.js 15 App Router，Tailwind CSS v4，组件使用 `@/components/ui/` 下的 Radix UI 封装
- **客户端 API**: `lib/api.ts` — 浏览器端 fetch 包装，`NEXT_PUBLIC_API_URL` 指向后端
- **服务端 API**: `lib/admin-data.ts` — RSC 中 `serverFetch<T>()`，`cache: "no-store"` 保证数据实时
- **页面**: 首页 `/` (DailyHero 骨架), `/photos`, `/photos/[id]`, `/history`, `/settings`, `/admin` (仪表盘)
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
                        daily-selection job (定时)
                                    ↓
                          每日精选 → dailyPicks
```

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
