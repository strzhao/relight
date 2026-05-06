---
active: true
phase: "done"
gate: ""
iteration: 1
max_iterations: 30
max_retries: 3
retry_count: 0
mode: "project"
plan_mode: ""
brief_file: ""
next_task: ""
auto_approve: false
knowledge_extracted: "skipped"
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/mac/.autopilot/sessions/mac/requirements/20260507-新开发一个-mac-照片壁"
session_id: 94610f0a-003c-49c2-a803-cddec78acf19
started_at: "2026-05-06T16:42:35Z"
---

## 目标
新开发一个 mac 照片壁纸 APP ，照片壁纸用的就是今日精选里的内容，注意图片和视频可能都会有

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档
项目模式 — 详见 `.autopilot/project/design.md`

**目标拆解**：新开发 SwiftUI macOS 壁纸 APP，消费 Relight 后端 `/api/daily/today`，图片直接 setDesktopImageURL，视频转动态 .heic（apple_desktop:h24）实现循环切换。

**关键技术决策（已与用户确认）**：
- 技术栈：SwiftUI 原生（macOS 13.0+）
- 视频策略：抽帧 → 动态 .heic
- 工程位置：monorepo 子包 `apps/mac/`

**关键技术验证**：
- AVAssetImageGenerator 抽帧、ImageIO 写 HEIC + XMP 可行（参考 wallpapper）
- NSWorkspace.setDesktopImageURL 仍为 macOS 14/15 官方 API
- 第三方设置 Sonoma Live Wallpaper 不稳定，统一走动态 .heic

详见 `.autopilot/project/design.md` 完整版。

## 实现计划
项目模式 DAG（7 个子任务）— 详见 `.autopilot/project/dag.yaml`

| ID | 任务 | 依赖 | 复杂度 |
|----|------|------|--------|
| 001-mac-xcode-scaffold | Xcode 工程脚手架 + monorepo 集成 | - | S |
| 002-relight-api-client | Swift RelightClient | 001 | M |
| 003-image-wallpaper-engine | 图片壁纸引擎 | 002 | M |
| 004-video-to-dynamic-heic | 视频→动态 .heic 引擎 | 002 | L |
| 005-menubar-and-settings-ui | 菜单栏 + 设置面板 | 001 | M |
| 006-coordinator-and-autostart | 调度协调器 + 自启动 | 003, 004, 005 | S |
| 007-package-readme | 打包脚本 + README | 006 | S |

每个任务独立执行，使用 `/autopilot next` 启动就绪任务。

## 红队验收测试
(待 implement 阶段填充)

## QA 报告
(待 qa 阶段填充)

## 变更日志
- [2026-05-06T16:42:35Z] autopilot 初始化，目标: 新开发一个 mac 照片壁纸 APP ，照片壁纸用的就是今日精选里的内容，注意图片和视频可能都会有
- [2026-05-07T00:00:00Z] design 阶段完成 — 知识库加载（13 条 decisions + 28 条 patterns）→ Plan Mode 探索 daily-pick API 契约 + 动态 .heic 技术验证 → 用户确认三大技术选型（SwiftUI / 动态 .heic / monorepo 子包）→ Plan Reviewer 审查 PASS（含 3 条重要建议已合入）→ 用户审批通过
- [2026-05-07T00:00:00Z] 项目模式落地 — 创建 .autopilot/project/{design.md, dag.yaml, tasks/001-007.md}（7 个独立任务），mode: project，phase: done。后续使用 /autopilot next 启动就绪任务（首批就绪：001-mac-xcode-scaffold）
