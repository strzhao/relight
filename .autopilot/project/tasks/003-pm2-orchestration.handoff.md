# 003-pm2-orchestration Handoff

**Commits**: `b5b3e7e` (feat) + `35565b7` (bump 0.7.4) + `f6b2a84` (CLAUDE.md ops 段)
**完成时间**: 2026-05-17
**状态**: ✅ done

## 实现摘要

后端 3 个 POST endpoint (`/api/runtime/workers/{start,stop,reload}`) 通过 `child_process.spawn("pnpm", ["workers:${action}"])` 调 PM2，继承 002 localhostOnly middleware 非 localhost POST 自动 403；ENOENT 时拼接友好中文提示。Mac 控制中心 3 按钮接通：按钮 enable 由 `workers.status` 派生（.running 启用停止/重启、.down 启用启动、.degraded/nil 全禁用），点击触发 `confirmationDialog` 二次确认，确认后 `await controlWorker + fetchOnce` 刷新；500 响应优先解码 stderr 单独展示（不展 raw JSON 串）。

## 文件变更

| 文件 | 改动 |
|---|---|
| `apps/backend/src/lib/config.ts` | +5 (repoRoot 字段 + node:path import) |
| `ecosystem.config.cjs` | +5/-1 (env REPO_ROOT: process.cwd()) |
| `apps/backend/src/routes/workers-control.ts` | 新建 +54 |
| `apps/backend/src/app.ts` | +2 (mount /api/runtime/workers) |
| `packages/shared/src/types.ts` | +9 (WorkerAction + WorkerControlResponse) |
| `packages/shared/src/routes.ts` | +3 (workersStart/Stop/Reload) |
| `apps/mac/Relight/UI/ControlCenter.swift` | +138/-14 (顶层 Models + ViewModel.controlWorker + actionBar + confirmationDialog + alert + helpers) |
| `apps/backend/src/routes/__tests__/workers-control.acceptance.test.ts` | 新建 +406 (15 cases A-G) |

## 下游须知（T4 必读）

### REPO_ROOT 已实现

`config.repoRoot` 字段已加，T4 直接 `config.repoRoot` 复用（如 PM2 log 路径计算）。`ecosystem.config.cjs` env 已注入。

### 共享 Models / API 复用

- T4 日志页：`/api/runtime/workers/logs` 端点会自动继承 localhostOnly 保护
- T4 设置页：`/api/runtime/config` 同理
- T4 不需要新建独立 isLocalhost 检测，直接用 `c.get("isLocalhost")` 决定脱敏

### Mac App ViewModel 扩展点

`RuntimeStatusViewModel` 现有：`fetchOnce()` / `controlWorker(_:)`。T4 可继续在此基础上加 `fetchLogs(lines:)` / `fetchConfig()`。

### 红队 fixture timing 教训

`spawn` mock 用 `mockImplementation` 而非 `mockReturnValue`，避免 emit 在 spawn handler 注册 listener 之前 fire（详见提交的 patterns）。

## 偏差说明

1. **acceptance test 体积比预估大**：brief 估 +120 行，实际 +406 行（15 it cases 完整覆盖 socket 行为表 × method）。范围扩大但都在契约覆盖内
2. **fixture timing bug 修复**：QA 阶段红队 fixture 触发 11 个 timeout，根因 emit schedule 在 makeMockChild 同步入队（patterns.md [2026-05-15] 类）。**仅改 timing 不改断言契约**（红队期望逻辑零变更），重构 8 处 beforeEach 为 setupSpawnMock 用 mockImplementation + setImmediate
3. **Tier 1.5 A/B (Mac UI confirmationDialog 操作)**：保留 ⚠️（无 SwiftUI UI automation 基础设施）；等价 POST 链路已在 C/D/G 通过 + Swift 代码 xcodebuild + qa-reviewer Section A 字面验证

## QA 摘要

- Tier 0 acceptance test 30 passed / 5 skipped（含红队 15 case 全过）
- Tier 1 shared typecheck ✅；backend typecheck 2 unrelated 预存 error 隔离验证；biome 单文件全 ✅；xcodebuild BUILD SUCCEEDED
- Wave 1.5 E=7=N，C/D/E/F/G ✅（实测 reload pid 48601→49066 真实变化、内网 403、XFF 仍 403、字面 body 契约匹配）；A/B Mac UI 限制 ⚠️
- Wave 2 qa-reviewer Section A 6/6 + Section B 无 OWASP 高置信度问题
