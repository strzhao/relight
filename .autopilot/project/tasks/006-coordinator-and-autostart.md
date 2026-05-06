---
id: 006-coordinator-and-autostart
title: 调度协调器 + Timer + SMAppService 自启动
complexity: S
depends_on:
  - 003-image-wallpaper-engine
  - 004-video-to-dynamic-heic
  - 005-menubar-and-settings-ui
status: pending
---

## 目标
实现 `WallpaperCoordinator` 把所有零件串起来：
1. 启动时自动拉取并应用今日精选
2. Timer 每天 06:30 检查更新（精选生成时间是 06:00）
3. 把任务 005 菜单栏的 `onRefreshNow` 接到 `coordinator.refreshNow()`
4. `SMAppService.mainApp` 实现登录时自启动（开关来自任务 005 的 `autoStart`）

## 架构上下文

参考 `.autopilot/project/design.md` 的「整体架构设计」「UserDefaults Key」章节。

### 关键事实
- **不重复设置**：用 `lastAppliedPickDate` 防止当天重复 → 拉到的 DailyPick.pickDate 与 lastAppliedPickDate 相同时跳过（但 `refreshNow` 用户手动触发时强制刷新）
- **Timer 实现**：`Timer.scheduledTimer(withTimeInterval: 60*60, repeats: true)` 每小时检查一次，到 6:30 之后且当天未应用则触发；不要用 cron 表达式
- **后端可能没起来**：网络错误捕获后只 OSLog warning，不弹窗（菜单栏 APP 不应骚扰用户）；下次轮询继续尝试
- **SMAppService**：macOS 13+ API，`SMAppService.mainApp.register()` / `.unregister()`；首次注册会触发系统授权弹窗（用户需要在 系统设置 → 通用 → 登录项 中开启）

## 输入契约

来自任务 002：`RelightClient`、`WallpaperCache`、`AppSettings`
来自任务 003：`ImageWallpaperEngine`、`WallpaperEngine` protocol
来自任务 004：`VideoWallpaperEngine`
来自任务 005：`MenuBarCommandBus`

## 输出契约（handoff）

### 必须创建的源文件

```
apps/mac/Relight/
├── Coordinator/
│   ├── WallpaperCoordinator.swift       # 主协调器
│   └── AutostartManager.swift           # SMAppService 包装
└── RelightApp.swift                      # 改造：在 init 时构建依赖图并注入到 MenuBarCommandBus
```

### WallpaperCoordinator 接口

```swift
public actor WallpaperCoordinator {
  public init(
    client: RelightClient,
    imageEngine: WallpaperEngine,
    videoEngine: WallpaperEngine,
    settings: AppSettings,
    logger: Logger
  )

  /// 用户手动触发或定时触发，强制刷新（忽略 lastAppliedPickDate）
  public func refreshNow() async

  /// 启动时调用：如 lastAppliedPickDate ≠ 今天，则拉取并应用
  public func bootstrapOnLaunch() async

  /// 启动后台 Timer（每小时检查一次）
  public func startScheduler() async
}
```

### 调度逻辑伪代码

```swift
func refreshNow() async {
  do {
    let pick = try await client.fetchTodayPick()
    guard let photo = pick.photo else { throw RelightError.noPickAvailable }
    let sourceURL = try await client.downloadOriginal(photo)
    let engine = photo.isVideo ? videoEngine : imageEngine
    _ = try await engine.apply(photo: photo, sourceURL: sourceURL, on: NSScreen.screens)
    settings.lastAppliedPickDate = pick.pickDate
    logger.info("壁纸已更新: \(pick.pickDate)")
  } catch {
    logger.error("刷新壁纸失败: \(error)")
  }
}

func bootstrapOnLaunch() async {
  let today = ISO8601 todayInTimezone("Asia/Shanghai")
  if settings.lastAppliedPickDate != today {
    await refreshNow()
  }
}

func startScheduler() async {
  while !Task.isCancelled {
    try? await Task.sleep(for: .seconds(3600))  // 1 小时
    let today = ISO8601 todayInTimezone("Asia/Shanghai")
    let now = currentBeijingTime()
    if now.hour >= 7 && settings.lastAppliedPickDate != today {
      await refreshNow()
    }
  }
}
```

### AutostartManager 接口

```swift
public final class AutostartManager {
  public func sync(enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
    } catch {
      logger.error("autostart sync failed: \(error)")
    }
  }
}
```

`AppSettings.autoStart` 的 `didSet` 触发 `AutostartManager.sync(enabled:)`。

### RelightApp.swift 改造

```swift
@main
struct RelightApp: App {
  @StateObject private var settings = AppSettings.shared
  @StateObject private var commandBus = MenuBarCommandBus()

  init() {
    let client = RelightClient(settings: AppSettings.shared)
    let cache = WallpaperCache.shared
    let coordinator = WallpaperCoordinator(
      client: client,
      imageEngine: ImageWallpaperEngine(),
      videoEngine: VideoWallpaperEngine(cache: cache),
      settings: AppSettings.shared,
      logger: ...
    )
    Task {
      await coordinator.bootstrapOnLaunch()
      await coordinator.startScheduler()
    }
    commandBus.onRefreshNow = { await coordinator.refreshNow() }
    commandBus.onOpenSettings = { ... }
  }
  ...
}
```

## 验收标准

1. **编译通过**：xcodebuild build 退出码 0

2. **bootstrapOnLaunch**（必跑，附 OSLog 输出）：
   - 启动 backend → 启动 APP
   - 观察 OSLog `subsystem: "app.relight.mac"`：应该看到 `bootstrapOnLaunch → refreshNow → 壁纸已更新: 2026-05-07`
   - 桌面壁纸已切换

3. **lastAppliedPickDate 防重复**：
   - 第一次启动后 `defaults read app.relight.mac app.relight.lastAppliedPickDate` 返回今天
   - 重启 APP，bootstrap 跳过 refresh（OSLog 应有 `already applied today, skip`）
   - 点菜单栏「立即更新壁纸」强制刷新（OSLog 应有 `manual refresh`）

4. **Timer**（在 QA 报告中说明，不强制实测 24h）：
   - 单元测试用注入的 fake clock 验证 6:30 触发逻辑
   - 报告中说明 Timer interval（建议 3600s）和当前时间判定

5. **SMAppService**（必跑）：
   - 在设置面板勾选「登录时自动启动」
   - 打开 系统设置 → 通用 → 登录项 → 应该看到 Relight 出现
   - 取消勾选 → 系统设置中消失
   - 报告中附系统设置截图（或 `osascript` 输出确认）

6. **错误恢复**：把 apiURL 改成无效地址 → bootstrap/refresh 不崩溃，OSLog warning + UI 不弹窗

## 重要约束

- **不要**改动任务 002、003、004、005 的源码（除 RelightApp.swift 改造）
- **不要**用第三方调度库
- **不要**做"前一天没拉到的精选今天补抽"逻辑（KISS）
- **不要**实现 toast 通知（macOS UserNotifications）—— 留给后续扩展

## handoff 必须包含

- APP 启动入口（RelightApp.swift）的依赖图
- WallpaperCoordinator 完整接口
- AutostartManager 行为说明
- 已用到的 entitlements（应该没有，无沙盒）
- 调度器是否后台运行的说明
- 整体集成 smoke test 命令清单（启动 backend → 启动 APP → 验证）
