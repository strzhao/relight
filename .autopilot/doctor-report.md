# Autopilot Doctor 诊断报告

**项目**: relight
**技术栈**: Node.js/TypeScript (pnpm monorepo + Turborepo) — Next.js 15 (web) + Hono (backend) + Drizzle ORM
**诊断时间**: 2026-05-04T14:30:00+08:00
**工作模式**: 修复模式 (--fix)

---

## 总评

**等级: C　　总分: 58/100**

项目工程基础较好（类型安全、构建系统、项目结构），但缺失 CI/CD、文档、性能保障等关键配套基础设施，导致 autopilot 部分功能不可用。

---

## 维度明细

| # | 维度 | 分数 | 状态 | 关键发现 |
|---|------|------|------|----------|
| 1 | 测试基础设施 | 7/10 | ✅ | L1+L2 覆盖（vitest 8 tests 含 API 契约测试），L3 缺失（Playwright 已装但无 e2e 文件），无覆盖率工具 |
| 2 | 类型安全 | 9/10 | ✅ | TypeScript 5.8.3 + strict:true + noEmit |
| 3 | 代码质量与健壮性 | 6/10 | ⚠️ | Biome lint+format 已配置，缺少错误处理基础设施和死代码检测 |
| 4 | 构建系统 | 8/10 | ✅ | build/dev 命令完整，Drizzle Kit 已配置，next/tsup/drizzle config 齐全 |
| 5 | CI/CD Pipeline | 0/10 | ❌ | 无 .github/workflows/，无任何 CI/CD 配置 |
| 6 | 项目结构 | 9/10 | ✅ | 清晰 monorepo 分层（apps/web, apps/backend, packages/shared），命名一致 |
| 7 | 文档质量 | 0/10 | ❌ | 无 CLAUDE.md，无 README.md |
| 8 | Git 工作流 | 7/10 | ✅ | husky + lint-staged + commitlint + .env.example，缺 worktree-links |
| 9 | 依赖与安全基线 | 7/10 | ✅ | pnpm-lock + .gitignore 覆盖 .env + zod，无 CI 安全扫描，19 个过期依赖 |
| 10 | AI 就绪度 | 5/10 | ⚠️ | 无 CLAUDE.md + 无 OpenAPI schema + 无 mock 基础设施，但有良好测试模板和语义化 scripts |
| 11 | 性能保障 | 1/10 | ❌ | 无 Lighthouse CI / 无 Playwright 性能测试 / 无 bundle size 监控 |

> 状态图标：✅ ≥ 7 | ⚠️ 4-6 | ❌ ≤ 3

### 性能保障分析（Dim 11 详情）

| 方向 | 状态 | 发现 |
|------|------|------|
| P1: Lighthouse CI | ❌ | 无 @lhci/cli 依赖，无 .lighthouseci.json 配置 |
| P2: Playwright 性能 | ❌ | 有 Playwright 但无性能测试文件（无 page.metrics / PerformanceObserver） |
| P3: Bundle Size | ❌ | 无 size-limit 或 bundlesize 工具，无 .size-limit.json |

### 测试金字塔分析（Dim 1 详情）

| 层级 | 状态 | 发现 |
|------|------|------|
| L1: 单元/组件测试 | ✅ | vitest 3.2.4 + 8 测试文件（7 acceptance + 1 smoke），源文件 56 个 |
| L2: API/集成测试 | ✅ | api-contract.acceptance.test.ts 通过 Hono request() 覆盖全部 6 个路由组（18 个端点） |
| L3: E2E 测试 | ❌ | @playwright/test 1.52.0 + playwright.config.ts 已配置，但 e2e/ 目录不存在，无 E2E 测试文件 |

---

## Autopilot 兼容性矩阵

| autopilot 功能 | 状态 | 依赖维度 | 说明 |
|----------------|------|----------|------|
| 红队验收测试 | ✅ | Dim 1 | vitest + acceptance test 模板可用 |
| Tier 0: 红队 QA | ✅ | Dim 1 | 同上 |
| Tier 1: 类型检查 | ✅ | Dim 2 | tsc --noEmit 可用 |
| Tier 1: Lint 检查 | ✅ | Dim 3 | biome check 可用 |
| Tier 1: 单元测试 | ✅ | Dim 1 | vitest run 可用 |
| Tier 1: 构建验证 | ✅ | Dim 4 | build 命令可用（未验证过构建成功） |
| Tier 3: Dev Server | ✅ | Dim 4 | turbo dev / next dev 可用 |
| 自动修复 lint | ✅ | Dim 3 | biome check --write 可用 |
| 智能提交 | ✅ | — | 始终可用 |
| Tier 1.5: API 集成验证 | ✅ | Dim 1 (L2) | Hono request() 测试已覆盖路由 |
| Tier 1.5: E2E 冒烟测试 | ❌ | Dim 1 (L3) | Playwright 已配置但无 E2E 文件，QA 降级为手工浏览器验证 |
| 安全审查（code-quality-reviewer） | ⚠️ | Dim 9 | 有 zod 但无 CI 安全扫描，审查缺少项目级安全上下文 |
| 红队契约测试 | ⚠️ | Dim 10 | 无 OpenAPI schema，红队依赖设计文档推断 API 契约 |
| Worktree 并行开发 | ⚠️ | Dim 8 | 无 worktree-links，web 端口硬编码，worktree 并行需手动配置 |
| Tier 3.5: 性能保障验证 | ❌ | Dim 11 + Dim 4 | 无性能工具，QA 跳过性能验证 |
| 性能预算断言（CI 质量门） | ❌ | Dim 11 + Dim 5 | 无 CI，无法做性能预算断言 |

> ✅ 完全可用 | ⚠️ 降级运行 | ❌ 不可用

---

## Top 3 改进建议

按投资回报率（影响/工作量）排序：

### 1. 创建 CI/CD Pipeline
- **问题**: 项目完全没有 CI/CD 配置，代码质量门（lint/typecheck/test/build）无法自动执行
- **影响**: 解锁所有 CI 相关的 autopilot 质量门（lint/typecheck/test/build 自动化验证）
- **解决方案**: 创建 `.github/workflows/ci.yml`，包含 lint → typecheck → test → build 四步质量门
- **预估耗时**: 10 分钟

### 2. 创建项目文档（CLAUDE.md + README.md）
- **问题**: 无 CLAUDE.md 和 README.md，AI 协作缺少项目上下文，开发者上手困难
- **影响**: 双倍提升 — AI 就绪度（Dim 10）和文档质量（Dim 7），解锁红队契约测试和精准设计文档生成
- **解决方案**: 生成 CLAUDE.md（架构说明 + 开发规范）和 README.md（项目介绍 + 快速开始）
- **预估耗时**: 10 分钟

### 3. 添加性能保障工具
- **问题**: 无任何性能监控，前端性能退化无法及时发现
- **影响**: 解锁 Tier 3.5 性能保障验证，为 CI 添加性能预算断言
- **解决方案**: 安装 size-limit（P3 bundle size 监控，最快见效），添加 Playwright 性能测试示例（P2）
- **预估耗时**: 10 分钟

---

## Quick Fixes

可立即执行的操作：

1. `mkdir -p .github/workflows` — 创建 CI 目录
2. `pnpm add -D size-limit @size-limit/preset-app` — 安装 bundle size 监控
3. `mkdir -p apps/web/e2e` — 创建 E2E 测试目录
