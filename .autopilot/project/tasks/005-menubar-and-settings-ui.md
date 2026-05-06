---
id: 005-menubar-and-settings-ui
title: NSStatusItem 菜单栏 + SwiftUI 设置面板
complexity: M
depends_on:
  - 001-mac-xcode-scaffold
status: pending
---

## 目标
把 Relight.app 从普通 SwiftUI 窗口 APP 改造成「菜单栏常驻 APP」：
1. 菜单栏图标（NSStatusItem），点击展开菜单：「立即更新壁纸」「打开设置...」「退出」
2. SwiftUI 设置面板：API URL、登录时自启动、（保留位）刷新策略
3. UserDefaults 持久化所有设置

## 架构上下文

参考 `.autopilot/project/design.md` 的「整体架构设计」「UserDefaults Key」章节。

### 关键事实
- 任务 001 把 `Info.plist` 的 `LSUIElement` 设为 false（普通 APP）。本任务改为 `true`，让 Dock 不显示图标，只在菜单栏出现
- 菜单栏 APP 的 SwiftUI 模板：`@main` + `MenuBarExtra` (macOS 13+ 原生支持，非 NSStatusItem)
- **优先**用 `MenuBarExtra` 而非 NSStatusItem（更现代、更 SwiftUI 风格）
- 设置窗口用 `Settings { ... }` scene（macOS 14 起 `Settings` 已稳定）

## 输入契约

来自任务 001：
- 已有 `RelightApp.swift` 入口和 `ContentView.swift`

来自任务 002：
- `AppSettings` 已有 `apiURL` 字段，本任务扩展添加 `autoStart`、`lastAppliedPickDate`

## 输出契约（handoff）

### 必须创建的源文件

```
apps/mac/Relight/
├── RelightApp.swift                # 改造为 MenuBarExtra + Settings scene
├── UI/
│   ├── MenuBarContent.swift         # MenuBarExtra 内容（菜单项）
│   ├── SettingsView.swift           # SwiftUI 设置主面板
│   └── SettingsTabs/
│       ├── GeneralSettingsTab.swift # API URL、自启动开关
│       └── AboutTab.swift           # 版本号、GitHub 链接（占位）
└── Settings/
    └── AppSettings.swift            # 扩展（新增 autoStart、lastAppliedPickDate Key）
```

### 菜单栏命令回调（任务 006 会使用）

定义弱解耦的回调机制，本任务**不实现**实际行为，只暴露入口：

```swift
public final class MenuBarCommandBus: ObservableObject {
  public var onRefreshNow: (() async -> Void)?
  public var onOpenSettings: (() -> Void)?
  // 任务 006 会注入实际 closure
}
```

菜单内容：
- 「拾光 — 当日精选」（顶部静态标题，灰色）
- 「立即更新壁纸」→ 调 `onRefreshNow`
- 分隔
- 「设置...」→ 调 `onOpenSettings`（用 `NSApp.sendAction(#selector(showSettingsWindow), ...)` 或 `EnvironmentValues.openSettings`）
- 「退出」→ `NSApp.terminate(nil)`

### AppSettings 扩展

任务 002 已经创建该类，本任务追加：

```swift
@Published public var autoStart: Bool {
  didSet { UserDefaults.standard.set(autoStart, forKey: Self.Keys.autoStart) }
}

@Published public var lastAppliedPickDate: String? {
  didSet { ... }
}

private struct Keys {
  static let apiURL = "app.relight.apiURL"
  static let autoStart = "app.relight.autoStart"
  static let lastAppliedPickDate = "app.relight.lastAppliedPickDate"
}
```

### Settings UI 草图

```
┌──────────── 拾光 设置 ────────────┐
│  [常规]  [关于]                   │
│ ─────────────────────────────────│
│ Relight 后端 API:                 │
│ ┌─────────────────────────────┐  │
│ │ http://localhost:3000        │  │
│ └─────────────────────────────┘  │
│                                  │
│ ☐ 登录时自动启动                  │
│   （需重启 APP 生效）              │
│                                  │
│ 上次设置壁纸: 2026-05-07          │
└──────────────────────────────────┘
```

`autoStart` 切换的实际 launchd 注册行为留给任务 006（SMAppService），本任务只持久化布尔值。

## 验收标准

1. **编译通过**：xcodebuild build 退出码 0

2. **APP 启动后**（必跑，附截图）：
   - Dock 不显示图标（`LSUIElement: true` 生效）
   - 屏幕右上角菜单栏出现 Relight 图标
   - 点击图标展开菜单，4 项可见

3. **设置面板**：点「设置...」→ 弹出 SwiftUI 设置窗口；修改 API URL 文本框 → 关闭窗口 → 重启 APP → 值保留

4. **MenuBarCommandBus**：
   - 单元测试：注入 mock closure → 触发菜单命令 → closure 被调用
   - 整体上没有耦合到 RelightClient / WallpaperEngine（MenuBarContent 只依赖 MenuBarCommandBus）

5. **「立即更新壁纸」当前行为**：因 `onRefreshNow` 在任务 006 才注入，本任务点击该项应该 OSLog 一行 `"refreshNow callback not wired"`，**不要**抛错或崩溃

## 重要约束

- **不要**在本任务里调用 RelightClient 或 WallpaperEngine —— 那是任务 006 的职责（注入 closure）
- **不要**实现真正的自启动（SMAppService 调用）—— 只持久化布尔值，注释里写 TODO 指向任务 006
- **不要**做美化（自定义图标资源、暗色模式适配等）—— 用 SF Symbol `photo.stack` 或 `wand.and.stars` 即可
- **不要**改动任务 002、003、004 的代码

## handoff 必须包含

- `MenuBarCommandBus` 完整接口和回调列表
- `AppSettings` 完整 Key 列表和默认值
- 设置窗口如何被打开（API 入口）
- 已知 TODO（autoStart 实际生效需任务 006）
