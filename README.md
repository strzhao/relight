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

## 桌面 App（macOS）

`apps/mac` 是「拾光」的 macOS 桌面端（菜单栏 App，自动把每日精选设为壁纸）。

### 安装（Homebrew，推荐 · 仅 Apple Silicon）

```bash
brew tap strzhao/relight
brew install --cask relight
```

更新到最新版：

```bash
brew upgrade --cask relight
```

或前往 [Releases](https://github.com/strzhao/relight/releases) 手动下载 `Relight-vX.Y.Z.zip`，解压后将 `Relight.app` 拖入 `Applications`（首次打开右键「打开」绕过 Gatekeeper）。

### 发布流程

向仓库推送 `vX.Y.Z` 形式的 tag 即触发 `.github/workflows/release.yml`：在 macOS runner 上 `xcodebuild archive`（Release，arm64，ad-hoc 签名）→ 打包 `Relight-vX.Y.Z.zip` → 创建 GitHub Release → 自动更新 `strzhao/homebrew-relight` tap 的 cask。

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
