# Handoff — 006-coordinator-and-autostart

**状态**: done | **commits**: 270ae5c (蓝队主体) + 3eee09b (红队脚本) | **完成时间**: 2026-05-07

## 实现摘要

把 001-005 所有零件串起来，完成端到端壁纸自动化链路。**APP 现在已经能自动工作了**。

### 新增文件
- `apps/mac/Relight/Coordinator/BeijingTime.swift` — `todayString` + `nowComponents`（TimeZone Asia/Shanghai）
- `apps/mac/Relight/Coordinator/AutostartManager.swift` — SMAppService.mainApp.register/unregister 包装
- `apps/mac/Relight/Coordinator/WallpaperCoordinator.swift` — actor 调度器
- `apps/mac/coordinator.acceptance.test.sh` — 红队 16 个 check

### 修改
- `RelightApp.swift` — init 构建依赖图（self-test early return 防双启动）+ body `.task` 注入 commandBus.onRefreshNow + `.onChange(of: autoStart)` 同步 AutostartManager；新增 SelfTest case `coordinator-bootstrap`
- `pbxproj` — GUID 0x69-0x6F

## 端到端链路

```
启动 APP
  │
  ├─→ MenuBarExtra（005）→ 菜单含「立即更新壁纸」
  │     └─ commandBus.onRefreshNow 已注入
  │           └─→ WallpaperCoordinator.refreshNow()
  │
  ├─→ Task.detached:
  │     await coordinator.bootstrapOnLaunch()  // 启动时检查 lastAppliedPickDate ≠ today → refreshNow
  │     await coordinator.startScheduler()     // 每小时检查，>=07:00 北京时间 + last≠today → refreshNow
  │
  └─→ refreshNow() 内部：
        1. RelightClient.fetchTodayPick() → DailyPick
        2. RelightClient.downloadOriginal(photo) → local URL
        3. photo.isVideo ? videoEngine : imageEngine
        4. engine.apply(photo, sourceURL, NSScreen.screens) → 设壁纸
        5. settings.lastAppliedPickDate = pick.pickDate
```

设置面板 Toggle「登录时自动启动」→ `settings.autoStart` didSet → `.onChange` 触发 → `AutostartManager.sync(enabled:)` → `SMAppService.mainApp.register()/unregister()`（首次注册触发系统授权弹窗）。

## QA 验收（16/16 ✅）
- xcodebuild Debug build ✅
- coordinator-bootstrap self-test 真实路径走通：清空 lastAppliedPickDate → fetch + download + 设壁纸成功 → 写入 `2026-05-07`
- 7 个现有 SelfTest cases 全部回归通过（codable / fetch / download / heic-schema-probe / image-wallpaper / video-wallpaper / menubar-smoke）
- pnpm typecheck ✅

## 设计偏差
- `.onChange(of:) { newValue in }` 用 macOS 13 兼容签名（旧版单参数），非 macOS 14+ 双参数（`{ _, newValue in }`），功能等价

## 下游任务对接（任务 007）

任务 007 仅做打包脚本 + README，可直接基于当前 commit `3eee09b`（HEAD）跑：
- `cd apps/mac && xcodebuild -scheme Relight -configuration Release archive ...`
- 或写 `apps/mac/build.sh` 封装

整体 MVP 验收（design.md 5 步）由任务 007 跑通。

## 已用 GUID
001-006: 0x18-0x22, 0x40-0x6F。任务 007 几乎不动 Swift 代码（仅 README + build script），无需新 GUID。
