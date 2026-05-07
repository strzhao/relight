# Handoff — 005-menubar-and-settings-ui

**状态**: done | **commit**: fabf6ad | **完成时间**: 2026-05-07

## 实现摘要

Relight.app 从普通窗口 APP 改造为菜单栏常驻 APP。任务 006（Coordinator）现在可以注入 `MenuBarCommandBus` 的回调来串起完整的拉取→下载→设壁纸链路。

### 新增文件
- `apps/mac/Relight/UI/MenuBarCommandBus.swift` — 弱解耦回调
- `apps/mac/Relight/UI/MenuBarContent.swift` — 菜单内容（macOS 13/14 兼容 openSettings）
- `apps/mac/Relight/UI/SettingsView.swift` — TabView 容器
- `apps/mac/Relight/UI/SettingsTabs/GeneralSettingsTab.swift` — API URL + 自启动 Toggle + 状态
- `apps/mac/Relight/UI/SettingsTabs/AboutTab.swift` — 版本号 + 图标
- `apps/mac/menubar.acceptance.test.sh` — 红队脚本（20 个 check）

### 修改
- `Settings/AppSettings.swift` — 追加 `autoStart: Bool` + `lastAppliedPickDate: String?`
- `RelightApp.swift` — WindowGroup → MenuBarExtra + Settings scenes，**保留 6 个现有 SelfTest cases** + 新增 `menubar-smoke`
- `Info.plist` — `LSUIElement: true`（Dock 不显示）
- `pbxproj` — GUID 0x5D-0x68

## 关键接口（任务 006 必读）

```swift
// MenuBarCommandBus（任务 006 在 RelightApp.init 注入实际 closure）
final class MenuBarCommandBus: ObservableObject {
  var onRefreshNow: (() async -> Void)?    // 用户点「立即更新壁纸」
  var onOpenSettings: (() -> Void)?         // 用户点「设置...」（macOS 13 fallback 用）
}

// AppSettings 扩展
@Published var autoStart: Bool                  // 任务 006 通过 didSet 触发 SMAppService.register/unregister
@Published var lastAppliedPickDate: String?     // 任务 006 写入今日 pickDate 防止重复设置
```

## 任务 006 集成示意

```swift
init() {
  // 现有 SelfTest 钩子（保留）
  ...
  // 新增：构建依赖图 + 注入 closure
  let coordinator = WallpaperCoordinator(
    client: RelightClient(),
    imageEngine: ImageWallpaperEngine(),
    videoEngine: VideoWallpaperEngine(),
    settings: settings
  )
  Task { await coordinator.bootstrapOnLaunch() }
  commandBus.onRefreshNow = { await coordinator.refreshNow() }
  // commandBus.onOpenSettings 由 MenuBarContent 内部 fallback 处理
  // 同时监听 settings.autoStart 的 didSet，触发 AutostartManager
}
```

## QA 验收摘要
- 红队脚本 20/20 ✅（A 文件 5 + B build 2 + C LSUIElement 1 + D 进程驻留 2 + E menubar-smoke 5 + F UserDefaults 2 + **G 关键回归 codable 2** + H typecheck 1）
- macOS 13/14 兼容 openSettings 已实现（@available(macOS 14, *) 子组件）
- 6 个现有 SelfTest cases 全部仍可跑通（G 组验证 codable 不被改造破坏）

## 已用 GUID 范围
001: 0x18-0x22 / 002: 0x40-0x51 / 003: 0x52-0x56 / 004: 0x57-0x5C / **005: 0x5D-0x68**
任务 006 起从 0x69 递增。

## 已知 ⚠️
- macOS 14+ 才能用 `@Environment(\.openSettings)`；macOS 13 落到 commandBus.onOpenSettings 兜底（任务 006 注入即可）
- "登录时自动启动" Toggle 当前仅持久化 Bool 值，**未生效**（任务 006 实现 SMAppService.mainApp.register/unregister）
- 退出 APP 后再启动，菜单栏图标可能需要几秒才出现（系统 status item 注册延迟）
