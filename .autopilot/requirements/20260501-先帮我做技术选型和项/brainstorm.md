# 拾光 (Relight) — 技术选型 Q&A 记录

## 目标

为「拾光」项目完成技术选型和项目脚手架搭建。拾光的核心功能是：AI 自动分析打标照片，每天精选最值得回忆的一张照片并配文。

## Q&A 汇总

### Q1: 平台形态
**A**: 全栈服务，后端为核心（持续照片分析归档），先支持 Web 端。macOS 后续上（小组件、屏幕背景等纯消费端，不带逻辑）。

### Q2: 后端语言/运行时
**A**: Node.js/TypeScript — 全栈统一语言，前后端共享类型。

### Q3: AI 模型
**A**: 本地 Ollama/llama-server 部署的 Qwen 多模态服务，走标准 OpenAI 兼容 API（方便后续切换）。当前 llama-server 运行在 `127.0.0.1:8001`，OpenAI 兼容端点 `/v1`。⚠️ 当前部署的是文本模型 Qwen3.6-35B，需要额外部署视觉模型用于照片分析。

### Q4: 前端框架
**A**: Next.js 15 App Router

### Q5: 照片来源与存储
**A**: 照片通过绿联私有云管理（手机同步到 NAS）。采用可配置的存储后端设计，默认本地目录扫描（用户自行挂载 NAS 到本地路径）。

### Q6: 开源友好设计
**A**: 存储层抽象化，支持多种 backend（本地目录、SMB 挂载点等），用户自由选择。

### Q7: 架构方案
**A**: 方案 A — Turborepo Monorepo：
- `apps/backend`: Fastify + BullMQ + Prisma
- `apps/web`: Next.js 15 App Router
- `packages/shared`: 共享类型和 API 契约
- pnpm workspace + Turborepo

## 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 运行时 | Node.js/TypeScript | 全栈统一 |
| 后端框架 | Fastify | 高性能，TypeScript 原生支持 |
| 任务队列 | BullMQ + Redis | 可靠的持续后台任务（照片扫描、AI 分析） |
| ORM | Prisma | 类型安全，SQLite → PG 平滑升级 |
| 数据库 | SQLite (起步) | 零配置，适合个人部署 |
| 前端 | Next.js 15 | SSR/SSG，App Router |
| AI 服务 | 本地 llama-server | OpenAI 兼容 API，无外部依赖 |
| 存储 | 抽象层 + 本地目录默认 | 开源友好，NAS 无关 |
| 包管理 | pnpm + Turborepo | Monorepo 最佳实践 |
