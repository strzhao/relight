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
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/batch/.autopilot/sessions/batch/requirements/20260504-当前的-AI-图片分析速"
session_id: b0f7e130-0f46-4c23-b688-ab0e2f475396
started_at: "2026-05-04T10:12:28Z"
---

## 目标
当前的 AI 图片分析速度太慢了，当前有一个任务已经执行了很久，但是才 100 个图片处理好，基于我当前设备情况帮我设计一个优化方案

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### 调研发现

- **推理引擎**: llama.cpp (llama-server)，部署在 `~/llama.cpp/build/bin/llama-server`
- **模型**: Qwen3.6-35B-A3B（MoE，256 专家，仅激活 ~3B），Q4_K_XL 量化
- **并发槽位**: `--parallel 2`（2 个推理 slot）
- **解码速度**: 67.3 tok/s，Metal 加速
- **图片传递**: 保持 base64 data URL（回环接口 ~40Gbps，33% 开销可忽略；文件路径不被任何推理引擎支持）

### P0-1: Worker 并发度 (workers/index.ts:16)
analyze-photo Worker 加 `concurrency: 2`，匹配 llama-server `--parallel 2`

### P0-2: 统一图片缩放 (jobs/analyze-photo.ts:50-67)
非 HEIC 图片也用 sharp 缩放到 2048px JPEG quality 85，payload 从 7-27MB 降到 ~300KB

### P1-1: AI API 超时 (ai/client.ts:4-7)
OpenAI 客户端加 `timeout: 120000` + `maxRetries: 0`

### P1-2: 标签批量写入 (jobs/analyze-photo.ts:128-160)
标签 upsert 用 `onConflictDoUpdate`（保留 category UPDATE），photoTags 用 `onConflictDoNothing`（替代 try-catch）

## 实现计划
- [x] P0-1: workers/index.ts — analyzeWorker 加 concurrency: 2
- [x] P0-2: jobs/analyze-photo.ts — 非 HEIC 图片 sharp 缩放到 2048px
- [x] P1-1: ai/client.ts — OpenAI 客户端加 timeout + maxRetries
- [x] P1-2: jobs/analyze-photo.ts — 标签批量写入（sql import + onConflictDoUpdate/onConflictDoNothing）

## 红队验收测试
- `apps/backend/src/__tests__/analyze-optimization.acceptance.test.ts` — 24 个验收测试全部通过
  - P0-1: Worker concurrency: 2 验证（4 测试）
  - P0-2: 图片缩放 2048px + JPEG quality 85 验证（9 测试）
  - P1-1: OpenAI timeout 120000 + maxRetries 0 验证（5 测试）
  - P1-2: 标签 onConflictDoUpdate/onConflictDoNothing 批量写入验证（6 测试）
- 验收标准覆盖率: 4/4 设计意图全部覆盖

## QA 报告

### 变更分析
- 变更类型：后端逻辑优化
- 影响半径：低（3 个文件，仅影响 AI 分析 Worker 内部流程）
- 3 个文件：workers/index.ts (+1), ai/client.ts (+2), jobs/analyze-photo.ts (+61/-31)

### Tier 0: 红队验收测试
✅ 24/24 通过（`analyze-optimization.acceptance.test.ts`）

### Tier 1: 基础验证
- ✅ 类型检查：我们的 3 个文件无新增错误
- ✅ Lint：通过（修复 2 个 Biome 问题后）
- ⚠️ 已有测试：88 个失败全部为已有失败（admin-api-contract、data-flow、scan-storage 等），与本次改动无关

### Tier 1.5: 真实场景验证
- ⏭️ 无需 dev server（纯后端配置和代码逻辑优化，无 UI/API 变更）

### QA 结论
✅ 全部通过。3 个文件改动均通过验收测试、类型检查、Lint 检查。无新增失败。

## 变更日志
- [2026-05-04T13:38:11Z] 用户批准验收，进入合并阶段
- [2026-05-04T10:12:28Z] autopilot 初始化，目标: 当前的 AI 图片分析速度太慢了，当前有一个任务已经执行了很久，但是才 100 个图片处理好，基于我当前设备情况帮我设计一个优化方案
- [2026-05-04T10:35:00Z] 设计方案通过审批：4 个优化改动（Worker 并发/图片缩放/API 超时/标签批量写入），涉及 3 个文件
- [2026-05-04T10:36:00Z] 本地调研：llama-server --parallel 2、MoE 3B 激活、67.3 tok/s；确认保持 base64 传图
- [2026-05-04T11:14:00Z] 蓝队实现完成：3 个文件修改（workers/concurrency + analyze/缩放 + client/timeout + analyze/批量标签写入）
- [2026-05-04T11:14:00Z] 红队验收测试完成：24 个测试全部通过，覆盖 4 个设计意图
- [2026-05-04T11:18:00Z] QA 完成：验收测试 24/24 ✅、类型检查 ✅、Lint ✅、已有测试无新增失败
