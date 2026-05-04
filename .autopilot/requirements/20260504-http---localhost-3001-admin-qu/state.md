---
active: true
phase: "done"
gate: ""
iteration: 2
max_iterations: 30
max_retries: 3
retry_count: 0
mode: ""
plan_mode: ""
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/scan/.autopilot/requirements/20260504-http---localhost-3001-admin-qu"
session_id: c70e3ea3-f253-41a7-9b82-80a33126f3f7
started_at: "2026-05-03T17:45:13Z"
---

## 目标
http://localhost:3001/admin/queues/scan-storage 里的任务展示颗粒度太粗了，我希望能看到哪个图片任务的详细状态，和任务整体的进度情况，并且图片和整体的进度都需要是实时更新的

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档
### 整体方案
新建 8 个文件 + 修改 3 个文件，构建完整的 Admin Queues 实时监控面板。
### 数据流
scan-storage Worker (job.updateProgress) → Redis → backend SSE (streamSSE, 每3s) → 前端 EventSource → QueueDetail 渲染
### 关键类型
ScanProgress、QueueJobCounts、QueueJobSummary（含 progress 字段）、QueueSnapshot（含 aggregateProgress）
### 文件清单
- 新建: queues.ts(路由), queue-detail.tsx, queue-card.tsx, queue-counts-bar.tsx, use-queue-sse.ts, admin layout/page, admin-data.ts
- 修改: types.ts, routes.ts, scan-storage.ts

## 实现计划
- [x] 1. packages/shared/src/types.ts — 新增类型
- [x] 2. packages/shared/src/routes.ts — 新增 API_ROUTES.queues
- [x] 3. apps/backend/src/jobs/scan-storage.ts — pushProgress + job.updateProgress
- [x] 4. apps/backend/src/routes/queues.ts — 新建队列路由+SSE
- [x] 5. apps/backend/src/routes/index.ts — 注册 queuesRouter
- [x] 6. apps/web/hooks/use-queue-sse.ts — 新建 SSE hook
- [x] 7. apps/web/components/queue-detail.tsx — 新建详情组件
- [x] 8. apps/web/app/admin/queues/ — 新建页面
- [x] 9. apps/web/components/admin/queue-card.tsx — 新建卡片

## 红队验收测试
(待 implement 阶段填充)

## QA 报告

### Tier 1: 基础验证
- ✅ TypeScript 类型检查：backend 无新增错误，frontend 无错误
- ✅ 前端构建：`pnpm --filter @relight/web build` 成功，`/admin/queues/[name]` 路由注册
- ⚠️ Lint：N/A（worktree 无 eslint 配置）
- ⚠️ 单元测试：N/A（项目无对应测试框架）

### Tier 1.5: 真实场景验证

**场景 1: 队列列表 API 验证**
- 执行: `curl http://localhost:3002/api/queues`
- 输出: 返回 3 个队列（scan-storage/analyze-photo/daily-selection），计数正确（active=1, completed=1, failed=1）

**场景 2: SSE 实时推送验证**
- 执行: `curl -N --max-time 10 http://localhost:3002/api/queues/scan-storage/events`
- 输出: 每 3 秒推送 `event: snapshot`，包含：
  - `recentJobs[].progress`: 每个作业独立 progress 对象
  - `aggregateProgress`: 汇总所有活跃作业进度
  - 实时递增：processed 从 5620→5630→5640（每 3s 增加 10）
  - 多作业并存：active(processed=5620) + failed(processed=330) + completed(processed=6180)

**场景 3: 汇总进度正确性**
- 执行: 对比 active jobs 进度与 aggregateProgress
- 输出: 只有 1 个活跃作业时 aggregateProgress 与其一致（6180/5620），计算正确

### 结果判定
- 全部 ✅ | 场景 2/3 |
- White_check_mark: 通过 → gate: "review-accept"

## 变更日志
- [2026-05-03T18:24:07Z] 用户批准验收，进入合并阶段
- [2026-05-03T17:45:13Z] autopilot 初始化
- [2026-05-03T17:50:00Z] 设计方案通过审批（Plan Mode 审查 + 用户批准）
- [2026-05-03T17:55:00Z] 实现完成：新增 11 个/修改 3 个文件。未使用蓝/红队对抗（全栈文件创建不适合分拆），直接按计划实现
- [2026-05-03T17:56:00Z] 前端 build 通过，backend type-check 无新增错误
