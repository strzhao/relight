# 004-placeholder-pages Handoff

**Commits**: `31fa14a` (feat) + `7423a6d` (bump 0.7.5) + `951b00f` (CLAUDE.md 段)
**完成时间**: 2026-05-17
**状态**: ✅ done

## 实现摘要

填充 Mac 控制中心 sidebar 三个 placeholder 页面：
- **报告页**：复用 `GET /api/daily?pageSize=30`，30 天列表 + 缩略图；空数据降级显示「暂无精选历史」+「立即生成」触发按钮
- **日志页**：5s 轮询 `GET /api/runtime/workers/logs?lines=200`，monospace 字体分区展示 stdout/stderr；macOS 13 deployment target 降级**手动按钮版** auto-follow（暂停跟随 + 「回到底部」显式调 `proxy.scrollTo`）
- **设置页**：拉一次 `GET /api/runtime/config`，分组展示 7 个 env 字段；aiApiKey 服务端掩码三态（空 → `""` / ≤8 → `"****"` / >8 → `前3****后4`）；底部 hint 引导编辑 .env

后端 2 个新 GET endpoint，继承 002 localhostOnly middleware；workers-logs 用 `readline` + circular buffer 读 PM2 日志（O(n) 内存非 O(file size)，可处理 MB 级日志），lines clamp [1, 1000]，ENOENT fallback 空数组不报 500。

## 文件变更

| 文件 | 改动 |
|---|---|
| `apps/backend/src/routes/workers-logs.ts` | 新建 34 |
| `apps/backend/src/routes/runtime-config.ts` | 新建 24 |
| `apps/backend/src/app.ts` | +4 (mount 两路由) |
| `apps/backend/src/routes/__tests__/workers-logs.acceptance.test.ts` | 新建 345 (13 cases) |
| `apps/backend/src/routes/__tests__/runtime-config.acceptance.test.ts` | 新建 392 (18 cases) |
| `packages/shared/src/types.ts` | +19 (WorkersLogs + RuntimeConfig) |
| `packages/shared/src/routes.ts` | +2 (workersLogs + config) |
| `apps/mac/Relight/UI/ControlCenter.swift` | +59 (VM 扩展 fetchLogs/fetchConfig + 顶层 Models + switch 替换) |
| `apps/mac/Relight/UI/ReportsPage.swift` | 新建 97 |
| `apps/mac/Relight/UI/LogsPage.swift` | 新建 95 |
| `apps/mac/Relight/UI/SettingsPage.swift` | 新建 78 |
| `apps/mac/Relight.xcodeproj/project.pbxproj` | +12 (4-section × 3，UUID 072-077) |

合计 12 files, 1158 insertions, 3 deletions。

## 下游须知（项目完成，留给未来的轮）

### 已落地的基础设施（其它团队 / 下一项目可复用）

- **localhostOnly middleware**（002）：在 `apps/backend/src/lib/middleware/localhost-only.ts`，所有 `/api/runtime/*` 自动继承，未来任何运行时端点不需要再加保护
- **config.repoRoot**（003）：`process.env.REPO_ROOT ?? process.cwd() 的 ../..` fallback，可用于任何 child_process spawn 需要 monorepo 根路径的场景
- **RuntimeStatusViewModel ViewModel 扩展点**：现有 `fetchOnce / controlWorker / fetchLogs / fetchConfig`，未来扩展运行时控制接口同 pattern
- **DailyPick Codable + RelightClient** 模式：未来 Mac App 增 daily 相关页面直接复用

### 已知遗留（留给下一轮）

- **设置页只读**：编辑能力 deferred — 编辑 .env 需 restart workers，与 003 reload 语义冲突，需要单独设计
- **日志页 macOS 14+ 优化**：若项目 deployment target 提到 14+，可改用 `onScrollGeometryChange` 自动 follow（替代当前手动按钮版）
- **ReportsPage AsyncImage 无 retry 机制**：低严重度 MVP 实现，未来可加 .failure 分支重试

## 偏差说明

1. **LogsPage 改用手动按钮版**：原设计 SwiftUI DragGesture 检测上滑暂停 auto-follow，plan-review 指出 macOS trackpad 滚动不触发 DragGesture（只捕获鼠标拖拽）；onScrollGeometryChange 是 macOS 14+ API，本项目 deployment target 13.0 不支持；降级为「暂停跟随」/「回到底部」两个显式按钮。设计文档 ### 改进建议 已采纳
2. **「回到底部」按钮 action 内显式 `proxy.scrollTo`**：仅设 flag 不滚动会卡停（onChange 监听 count 但 count 未变）。设计文档 ### 改进建议 已采纳
3. **嵌套字段权威**：设计文档早期跨任务约束段写 `config.aiBaseUrl` 平铺，实际 config.ts 是嵌套 `config.ai.baseUrl`；蓝队按设计文档 § 关键代码片段权威实现（plan-review 重要建议 1）
4. **commit-agent 修红队 fixture lint**：commit-agent 触发 biome pre-commit hook 报 `useYield`（async function* 内无 yield 直接 throw），修为手写 AsyncIterator（next() 返回 Promise.reject）— **不改断言契约**，等价行为，符合 patterns 「fixture 自身 lint bug」处理

## QA 摘要

- Tier 0 联跑 4 acceptance test files: **61 passed | 5 skipped**（004 新 31 cases + 003 15 + 002 15 全过；5 skipped 是 002 Redis 沙箱预存）
- Tier 1 shared typecheck ✅；backend typecheck 2 unrelated 预存 error 隔离验证；biome OOM（工具问题，contract-checker + qa-reviewer 字面验证补位）；**xcodebuild BUILD SUCCEEDED**
- Wave 1.5 E=7=N 全 ✅：报告页空降级文案命中 / 报告 API 13 条数据 / 日志 API 形状真实数据 / aiApiKey 实测 `qwe****-key` 已掩码 / 非 localhost GET 200 不脱敏 / lines clamp 红队 mock 验证
- Wave 2 qa-reviewer Section A 8/8 + Section B 仅 1 低严重 AsyncImage 无 retry
- contract-checker 0 mismatches
