# Deep Design Q&A 记录

## 目标
优化存储源的扫描逻辑，把文件扫描和 AI 分析做成 2 个步骤，先做文件扫描让我能通过列表文件树看到所有的文件，然后通过选择相关文件触发 AI 扫描

## Q1: 扫描粒度
**问**: 「文件扫描」这一步的粒度是什么？是纯列出文件（不入库），还是保持现有的扫描入库逻辑只是跳过 AI 分析？

**答**: 保持扫描入库 — 保持现有扫描逻辑（去重、入库、生成缩略图），但跳过 AI 分析。用户从已入库的照片中选择，触发 AI 分析。

## Q2: 选择机制
**问**: 用户在文件树中选择文件触发 AI 分析时，选择粒度是什么？

**答**: 文件级多选 — checkbox 多选单个文件 + 全选/反选操作。

## Q3: API 范围
**问**: 这个需求的范围应该多大？

**答**: 最小 API 扩展 — 只新增 2 个 API：
- GET /api/storage/:id/files（列出已扫描文件树）
- POST /api/analyze（选中文件触发 AI 分析）
存储源创建回退到扫描时自动创建，不提供完整 CRUD。

## Q4: 文件树展示方式
**问**: 分层树 vs 扁平列表？

**答**: 方案 A: 分层树 — 按目录层级组织，文件夹可展开/折叠，支持文件夹级选中（选中父节点 = 选中所有子节点）。

## 最终技术决策摘要

| 决策 | 选择 |
|------|------|
| 扫描粒度 | 保持扫描入库（去重+缩略图），仅跳过 AI 分析 |
| 文件选择 | 文件级多选 + checkbox + 全选/反选 |
| API 扩展 | 最小化：GET /api/storage/:id/files + POST /api/analyze |
| 文件展示 | 分层目录树，文件夹可折叠，父节点选中联动子节点 |

## 现有代码上下文

- 项目: Turborepo Monorepo (Hono + Drizzle + Biome + BullMQ)
- 已有 8 张表: storage_sources, photos, tags, photo_tags, photo_analyses, daily_picks, scan_logs, settings
- 已有 scan:storage worker（递归扫描 → 去重 → 入库 → 缩略图 → 自动入队 analyze）
- 已有 analyze:photo worker（读文件 → AI 调用 → 解析 → 写 tags/analyses）
- 前端为 Next.js 15 + React 19 + Tailwind 4，当前全部占位界面
- 存储源 type 枚举: local/smb/webdav，仅 local 已实现
- POST /api/scan 当前接收可选的 storageSourceId，自动创建或更新存储源
