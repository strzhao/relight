# CLAUDE.md — relight

照片 AI 分析与管理平台。支持照片存储扫描、AI 标签分析、每日精选推荐。

## 架构概览

```
apps/
  web/       Next.js 15 (App Router) + React 19 + Tailwind CSS 4
  backend/   Hono + Drizzle ORM + SQLite (better-sqlite3) + BullMQ + ioredis
packages/
  shared/    Zod schemas + 共享类型（API 契约、分页、照片/标签模型）
```

- **Web 端口**: 3001
- **Backend 端口**: 3000 (可配 `PORT` 环境变量)
- **包管理器**: pnpm 10 + Turborepo

## 常用命令

```bash
pnpm dev           # 启动所有服务 (turbo dev)
pnpm build         # 构建所有包 (turbo build)
pnpm lint          # Biome 检查
pnpm format        # Biome 自动格式化
pnpm typecheck     # 全量类型检查 (turbo typecheck)
pnpm test          # 运行所有 Vitest 测试
pnpm test:e2e      # Playwright E2E 测试 (需先 dev)
pnpm db:push       # Drizzle schema → SQLite
pnpm db:studio     # Drizzle Studio 数据浏览
```

## 开发规范

- **Biome** 负责 lint + format + organizeImports，缩进 2 空格，行宽 100
- **TypeScript strict 模式**，禁止 `any`（极小例外需注释说明）
- **Commit 规范**: Conventional Commits（commitlint 检查）
- **Pre-commit**: lint-staged 自动运行 `biome check --write`
- **测试**: Vitest，验收测试文件命名 `*.acceptance.test.ts`
- **API 响应格式**: 遵循 `ApiResponse<T>` / `PaginatedResponse<T>`（定义在 `packages/shared`）

## 关键设计决策

- **SQLite 本地数据库**：无需独立 DB 服务，适合个人/家庭使用场景
- **Hono 轻量框架**：比 Express 更快，原生 TypeScript 支持，request() 方法方便集成测试
- **Drizzle ORM**：类型安全的 SQL 构建器，migration 通过 `drizzle-kit` 管理
- **BullMQ + Redis**：异步任务队列（照片扫描、AI 分析、每日精选生成）
- **AI 服务**：OpenAI 兼容 API 协议，支持 Qwen 视觉模型
- **缩略图**：sharp 生成 JPEG 缩略图存储到本地文件系统
