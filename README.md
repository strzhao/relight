# relight

照片 AI 分析与管理平台 — 扫描本地照片库，通过 AI 视觉模型自动生成标签和分析，提供每日精选推荐。

## 技术栈

| 层 | 技术 |
|---|------|
| Web 前端 | Next.js 15, React 19, Tailwind CSS 4 |
| 后端 API | Hono, Drizzle ORM, SQLite |
| 任务队列 | BullMQ + Redis |
| AI 服务 | OpenAI 兼容 API（Qwen 视觉模型） |
| 工具链 | TypeScript, Biome, Vitest, Playwright, Turborepo, pnpm |

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 10
- Redis（BullMQ 任务队列）

### 安装与运行

```bash
# 安装依赖
pnpm install

# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入你的配置

# 初始化数据库
pnpm db:push

# 启动开发服务
pnpm dev
```

- Web: http://localhost:3001
- Backend: http://localhost:3000

## 项目结构

```
apps/web/          Next.js 前端应用
apps/backend/      后端 API + 任务队列
packages/shared/   共享类型与 Zod Schema
```

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 启动所有开发服务 |
| `pnpm build` | 构建所有包 |
| `pnpm lint` | Biome 代码检查 |
| `pnpm format` | Biome 自动格式化 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 运行单元/集成测试 |
| `pnpm test:e2e` | 运行 E2E 测试 |
| `pnpm db:push` | 推送 Drizzle schema |
| `pnpm db:studio` | 打开数据库浏览界面 |
