---
id: 001-mac-xcode-scaffold
title: Xcode 工程脚手架 + monorepo 集成
complexity: S
depends_on: []
status: pending
---

## 目标
在 monorepo 子包 `apps/mac/` 内创建一个最小可运行的 SwiftUI macOS APP 工程，名为 Relight，能用 `xcodebuild` 命令行编译为 `.app` Bundle。

## 架构上下文

参考 `.autopilot/project/design.md` 的「整体架构设计」章节。本任务是所有 macOS APP 任务的根，奠定工程结构。

### 关键技术决策（已锁定）
- macOS 部署目标：`13.0` (Ventura)
- Bundle ID：`app.relight.mac`
- 签名：ad-hoc Sign to Run Locally（无需 Apple Developer 账号）
- 沙盒：**关闭**（Application Support 写入 + 视频解码权限不必走沙盒）
- Swift 版本：5.10+（Xcode 15+）

## 输入契约
- 当前 monorepo 根：`/Users/stringzhao/workspace/relight/.claude/worktrees/mac/`
- 需在其中新建 `apps/mac/` 子目录

## 输出契约（handoff）

工程结构（必须严格遵守）：

```
apps/mac/
├── Relight.xcodeproj/                    # Xcode 工程
├── Relight/                              # APP 源码目录
│   ├── RelightApp.swift                  # @main 入口（最简：一个空 SwiftUI 窗口）
│   ├── ContentView.swift                 # 占位主视图（写死「Relight」标题即可）
│   ├── Assets.xcassets/                  # 资源
│   │   └── AppIcon.appiconset/          # APP 图标占位
│   └── Info.plist                        # APP 元数据
├── README.md                             # 简要说明：如何在 Xcode 打开 / 命令行编译
├── .gitignore                            # 忽略 build/, DerivedData/, .DS_Store
└── package.json                          # 仅占位（让 turbo 识别 workspace）
```

`apps/mac/package.json` 内容：
```json
{
  "name": "@relight/mac",
  "private": true,
  "version": "0.0.1",
  "scripts": {
    "build": "xcodebuild -project Relight.xcodeproj -scheme Relight -configuration Release build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO",
    "lint": "echo 'no swift lint configured yet'",
    "format": "echo 'no swift format configured yet'"
  }
}
```

`Info.plist` 关键键：
- `CFBundleIdentifier` → `app.relight.mac`
- `CFBundleName` → `Relight`
- `CFBundleDisplayName` → `拾光`
- `LSMinimumSystemVersion` → `13.0`
- `LSUIElement` → `false`（先以普通 APP 启动；任务 005 改为菜单栏 APP 时再改 true）

`Relight.xcodeproj` 配置：
- Target: `Relight` (macOS App)
- Deployment target: macOS 13.0
- Code Signing Style: Automatic + Sign to Run Locally
- Build Settings: SWIFT_VERSION=5.0+，ENABLE_HARDENED_RUNTIME=YES
- App Sandbox: NO

## 验收标准

1. **编译通过**（必跑）：
   ```bash
   cd apps/mac
   xcodebuild -project Relight.xcodeproj -scheme Relight -configuration Debug build \
     CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO -derivedDataPath ./build
   ```
   退出码 0，build/Build/Products/Debug/Relight.app 存在

2. **APP 能启动**（必跑）：
   ```bash
   open apps/mac/build/Build/Products/Debug/Relight.app
   ```
   屏幕上出现一个 SwiftUI 窗口

3. **monorepo 集成**：
   - 在仓库根跑 `pnpm install` 不报错（package.json 合法）
   - `pnpm --filter @relight/mac build` 能调起 xcodebuild

4. **不破坏现有工作流**：
   - `pnpm typecheck` 仍然通过（不影响 backend / web）
   - `pnpm lint` 仍然通过

## 重要约束

- **不要**生成任何 RelightClient、WallpaperEngine 等业务逻辑代码 —— 那是后续任务
- **不要**配置 entitlements 让 APP 进入沙盒
- **不要**引入第三方 Swift Package（Swift Package Manager dependencies），保持纯 Foundation/SwiftUI/AppKit
- README.md 简洁，仅说明：在 Xcode 打开方式、命令行编译命令、APP 当前状态（"骨架"）

## handoff 必须包含

- Xcode 项目文件路径：`apps/mac/Relight.xcodeproj`
- Bundle ID：`app.relight.mac`
- 部署目标：macOS 13.0
- 已配置的 entitlements（应该没有 — 默认无沙盒）
- 命令行编译命令（验收标准 1 中的命令）
- 已有源文件清单（RelightApp.swift / ContentView.swift / Info.plist）
- 如何添加新 Swift 文件到 target（讲清楚下一个任务往哪里放新代码）
