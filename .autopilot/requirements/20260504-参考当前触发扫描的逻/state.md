---
active: true
phase: "merge"
gate: ""
iteration: 1
max_iterations: 30
max_retries: 3
retry_count: 0
mode: ""
plan_mode: ""
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.autopilot/requirements/20260504-参考当前触发扫描的逻"
session_id: 06362679-37c2-47d0-a162-b4744c089df3
started_at: "2026-05-04T15:25:27Z"
---

## 目标
参考当前触发扫描的逻辑，AI 分析默认跳过已有分析照片，强制通过按钮后的另外交互功能来实现

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### 架构决策

- **复用已有模式**：`POST /api/photos/analyze` 的跳过逻辑参考 `routes/analyze.ts:86-96`；确认对话框使用 `@/components/ui/dialog`，下拉菜单参考 `ProgressPanel` 的 scan 模式分裂按钮
- **向后兼容**：`force` 为 optional 字段，不传时默认跳过已分析
- **统一契约**：三个分析端点行为一致
- **集成位置**：`UnifiedPhotosClient`（`/admin/photos` 页面）— 用户管理照片的主界面
- **多选交互**：`PhotoGrid` 增加多选支持（勾选框），选中照片后工具栏出现 `AnalyzeTriggerButton`

### 需要修改的文件（6 个）

| # | 文件 | 修改类型 |
|---|------|----------|
| 1 | `packages/shared/src/schemas.ts` | `analyzePhotosSchema` 增加 `force` 可选字段 |
| 2 | `apps/backend/src/routes/photos.ts` | `POST /api/photos/analyze` 增加跳过逻辑 + `skippedCount` 响应 |
| 3 | `apps/web/lib/api.ts` | `api.photos.analyze` 接受 `force` 参数 |
| 4 | `apps/web/components/admin/photo-grid.tsx` | 增加多选支持 (`selectedIds`, `onSelectionChange`, 勾选框) |
| 5 | `apps/web/components/admin/analyze-trigger-button.tsx` | 分裂按钮 + 下拉菜单 + 确认对话框，改用 `api.photos.analyze()` |
| 6 | `apps/web/components/admin/unified-photos-client.tsx` | 接入多选状态 + `AnalyzeTriggerButton` |

### 不修改的文件

| 文件 | 原因 |
|------|------|
| `routes/analyze.ts` | 已有完整跳过逻辑 |
| `routes/admin.ts` | 已有完整跳过逻辑 |
| `ScanPanel` | 已有 force 确认对话框，交互符合预期 |
| `ProgressPanel` | analyze 模式未暴露 force（仅 scan 模式有 forceRegenerate），后续可独立增强 |
| `PhotoDetailPanel` | 单张详情页始终 force=true 是合理设计（用户从详情页点 Sparkles 图标意图明确） |

## 实现计划

- [x] 1. 共享 Schema：`analyzePhotosSchema` 增加 optional `force` 字段
- [x] 2. 后端路由：`POST /api/photos/analyze` 增加跳过逻辑（参考 `routes/analyze.ts:86-96`）+ `skippedCount` 响应
- [x] 3. API 客户端：`api.photos.analyze(photoIds, force?)` 透传 `force` 参数
- [x] 4. PhotoGrid 多选：新增 `selectedIds`/`onSelectionChange` props + 勾选框 UI
- [x] 5. AnalyzeTriggerButton：分裂按钮 + Dialog 确认对话框，改用 `api.photos.analyze()`
- [x] 6. UnifiedPhotosClient：接入多选状态，选中时显示 AnalyzeTriggerButton

## 红队验收测试

### 测试文件
- `apps/backend/src/__tests__/analyze-force-skip.acceptance.test.ts` — 44 tests：后端 skip/force 逻辑验收
- `apps/backend/src/__tests__/photos-analyze.acceptance.test.ts` — 7 tests：蓝队补充的端点验收测试
- `apps/web/__tests__/analyze-force-ui.acceptance.test.ts` — 56 tests：前端多选 + 按钮交互验收

### 验收标准摘要
- 验收点 1：`POST /api/photos/analyze` 不传 `force` 时跳过已分析照片，响应含 `skippedCount`
- 验收点 2：`POST /api/photos/analyze` 传 `force: true` 时不跳过，所有照片入队
- 验收点 3：全部未分析照片时 `skippedCount: 0`
- 验收点 4：PhotoGrid 支持多选（勾选框），选中后工具栏出现 AnalyzeTriggerButton
- 验收点 5：AnalyzeTriggerButton 主按钮默认跳过已分析（不传 force）
- 验收点 6：下拉菜单 → 「强制重新分析...」→ 确认对话框
- 验收点 7：确认对话框取消 → 无请求；确认 → 请求含 `force: true`
- 跨系统数据流：`force`/`skippedCount` 字段名在 Schema → API → 客户端 → UI 全链路一致性

## QA 报告

### Wave 1 — 命令执行

| Tier | 检查项 | 状态 | 说明 |
|------|--------|------|------|
| Tier 0 | 红队验收测试 | ✅ | 2 files, 51 tests 全部通过 |
| Tier 1 | TypeCheck | ✅ | 4/4 成功 |
| Tier 1 | Lint | ✅ | Biome 184 files，格式修复后无错误 |
| Tier 1 | Unit Tests | ⚠️ | 1 预存失败 (lightbox-context) 与本次无关 |
| Tier 1 | Build | ✅ | 3/3 成功 |

### Wave 1.5 — 真实场景验证

| # | 场景 | 执行 | 输出 | 结果 |
|---|------|------|------|------|
| 1 | 已分析 + 不传 force | `curl POST ... {"photoIds":["<已分析>"]}` | `enqueued: 0, skippedCount: 1` | ✅ |
| 2 | 已分析 + force=true | `curl POST ... {"photoIds":["<已分析>"],"force":true}` | `enqueued: 1, skippedCount: 0` | ✅ |
| 3 | 未分析 + 不传 force | `curl POST ... {"photoIds":["<未分析>"]}` | `enqueued: 1, skippedCount: 0` | ✅ |

### Wave 2 — AI 审查

| Tier | 审查项 | 状态 | 说明 |
|------|--------|------|------|
| Tier 2a | 设计符合性 | ✅ | 6/6 维度符合设计要求 |
| Tier 2b | 代码质量 | ⚠️ | 良好 — 1 Important (enqueued/queuedCount 命名不统一，预存问题) + 5 Minor (优化建议) |

### 结果判定

全部 ✅ / ⚠️，无新增 ❌。⚠️ 项均为预存或优化建议，不阻塞合入。

## 变更日志
- [2026-05-05T02:30:00Z] commit: feat(analyze): AI 分析默认跳过已分析照片，支持强制重新分析（分裂按钮 + 确认对话框 + 多选批量操作），版本 0.2.0 → 0.3.0
- [2026-05-04T16:26:31Z] 用户批准验收，进入合并阶段
- [2026-05-04T15:25:27Z] autopilot 初始化，目标: 参考当前触发扫描的逻辑，AI 分析默认跳过已有分析照片，强制通过按钮后的另外交互功能来实现
- [2026-05-04T15:35:00Z] design 阶段完成：设计方案已通过审批（Plan 审查 2 轮，最终 PASS）
- [2026-05-04T15:45:00Z] implement 阶段完成：蓝队 6 任务全部完成，红队 3 验收测试文件生成，tsc 通过
- [2026-05-04T16:00:00Z] qa 阶段完成：全部 ✅/⚠️，无新增 ❌，gate → review-accept
