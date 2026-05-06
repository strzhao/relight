---
active: true
phase: "design"
gate: ""
iteration: 1
max_iterations: 30
max_retries: 3
retry_count: 0
mode: "single"
plan_mode: ""
brief_file: "/Users/stringzhao/workspace/relight/.claude/worktrees/mac/.autopilot/project/tasks/001-mac-xcode-scaffold.md"
next_task: ""
auto_approve: true
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/mac/.autopilot/sessions/mac/requirements/20260507-001-mac-xcode-scaffold"
session_id: 94610f0a-003c-49c2-a803-cddec78acf19
started_at: "2026-05-06T17:06:18Z"
---

## 目标
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


--- 架构设计摘要 ---
# 项目设计 — 拾光 Mac 壁纸 APP

## Context

**为什么做**：拾光（Relight）当前已通过 AI 视觉模型每日精选最佳照片/视频（`/api/daily/today` 端点 + 两阶段 AI 流水线产出 `DailyPick`），但用户消费侧只有 Web 端 `DailyHero`。Mac 桌面才是用户每天高频接触的界面 —— 把每日精选自动设置为桌面壁纸，让 AI 选出的回忆「占据视野中央」，是 Relight 价值闭环的关键一步。

**核心要求**：
- 自动消费 `/api/daily/today` 拿到当日精选（图片或视频）
- 图片直接设为桌面壁纸；视频转成 macOS 原生「动态 .heic」壁纸（按时间切换 16 帧）
- 全新 macOS APP，不打扰已有的 backend / web 工作流

**关键技术决策**（已与用户确认）：
- 技术栈：SwiftUI 原生（macOS 13 Ventura+ 部署目标）
- 视频策略：抽帧合成动态 .heic（Apple 原生格式，依赖 ImageIO + XMP 元数据）
- 工程位置：monorepo 子包 `apps/mac/`（pnpm 不直接构建，turbo 透传 xcodebuild）

**关键技术验证**（已通过 web 检索确认可行）：
- `apple_desktop:h24` time-based 模式：HEIC 中嵌 N 帧 + base64-encoded plist 描述每帧的时间百分比 → macOS 系统自动按时间切换（参考 wallpapper 项目 https://github.com/mczachurski/wallpapper）
- AVAssetImageGenerator 可纯 Swift 抽帧，无需 ffmpeg 依赖
- `NSWorkspace.shared.setDesktopImageURL(_:for:options:)` 仍是 macOS 14/15 设置壁纸的官方 API，支持 HEIC，多显示器通过 for 参数分别设置
- 第三方设置 Sonoma Live Wallpaper（视频壁纸文件夹方案）依赖私有目录，不稳定，**本项目放弃此路径**，统一走动态 .heic

## 整体架构设计

```
┌─────────────────────────────────────────────────────────┐
│  Relight.app (SwiftUI macOS App)                        │
│  ┌──────────────┐    ┌─────────────────────────────┐   │
│  │ 菜单栏 UI    │    │ Settings UI (SwiftUI 窗口)   │   │
│  │ NSStatusItem │    │ API URL / 刷新策略 / 自启动  │   │
│  └───────┬──────┘    └────────────┬────────────────┘   │
│          │                        │                     │
│          ↓                        ↓                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ WallpaperCoordinator (调度层)                    │   │
│  │   • 启动时 / Timer 每天 06:30 / 用户手动触发      │   │
│  └─────────┬───────────────────────────────────────┘   │
│            │                                            │
│  ┌─────────↓──────────────────┐                         │
│  │ RelightClient              │                         │
│  │   GET /api/daily/today     │ → DailyPick + Photo     │
│  │   GET /api/photos/:id/orig │ → 原始文件二进制         │
│  └─────────┬──────────────────┘                         │
│            │                                            │
│            ├──── 图片 ────→  ImageWallpaperEngine        │
│            │                  ↓                         │
│            │              setDesktopImageURL            │
│            │                                            │
│            └──── 视频 ────→  VideoWallpaperEngine        │
│                              ↓ AVAssetImageGenerator    │
│                              16 张 CGImage              │
│                              ↓ ImageIO + XMP plist      │
│                              dynamic.heic               │
│                              ↓                          │
│                              setDesktopImageURL         │
└─────────────────────────────────────────────────────────┘

缓存路径: ~/Library/Application Support/Relight/wallpapers/
持久化: UserDefaults (apiURL, autoStart, lastPickDate)
自启动: SMAppService.mainApp (macOS 13+)

> 📚 项目知识库已存在: .autopilot/。design 阶段请先加载相关知识上下文。

## 设计文档

### Context
作为项目模式的第一个原子任务（complexity: S），本任务是后续 6 个 Swift 任务的工程基座。失败的脚手架 = 整个项目卡死，因此核心要求是**确定性可重现**：脱离 Xcode GUI 也能 100% 可靠地从源码重建 Relight.app。

### 关键技术决策

**.pbxproj 生成方式 → 手写最小版本**

| 候选 | 评估 |
|------|------|
| **手写最小 .pbxproj**（选） | 无外部工具依赖；OpenStep plist 格式有成熟模板（约 220 行），稳定 GUID 可重现；最契合 autopilot 自动化场景 |
| xcodegen | 需 `brew install xcodegen`，引入工具链依赖；YAML 易读但 .pbxproj 仍是产物，本质相同 |
| swift package (SPM) | SPM 在 macOS 应用 target 上仍需 `executableTarget` + 自定义 Info.plist，xcodebuild 兼容性不如 .xcodeproj |
| Xcode GUI 创建后提交 | 无法在 autopilot 中复现，违反"确定性"目标 |

**Build settings 关键值**：
- `MACOSX_DEPLOYMENT_TARGET = 13.0`
- `PRODUCT_BUNDLE_IDENTIFIER = app.relight.mac`
- `PRODUCT_NAME = Relight`
- `SWIFT_VERSION = 5.0`
- `CODE_SIGN_STYLE = Automatic`，`CODE_SIGN_IDENTITY = -`（ad-hoc）
- `ENABLE_HARDENED_RUNTIME = YES`，`ENABLE_APP_SANDBOX = NO`
- `GENERATE_INFOPLIST_FILE = NO`，`INFOPLIST_FILE = Relight/Info.plist`（手写 Info.plist 而非自动生成）

**.pbxproj 必备 sections**：PBXBuildFile / PBXFileReference / PBXFrameworksBuildPhase / PBXGroup / PBXNativeTarget / PBXProject / PBXResourcesBuildPhase / PBXSourcesBuildPhase / XCBuildConfiguration (Debug+Release) / XCConfigurationList。链接系统框架最少（仅靠 SwiftUI 隐式带入 Foundation/AppKit）。

### 文件清单

```
apps/mac/
├── .gitignore                              # 忽略 build/, DerivedData/, *.xcuserstate, .DS_Store
├── README.md                               # 简要说明：环境/构建/运行
├── package.json                            # @relight/mac workspace 占位 + xcodebuild 代理脚本
├── Relight.xcodeproj/
│   └── project.pbxproj                     # ~220 行手写 OpenStep plist
└── Relight/
    ├── RelightApp.swift                    # @main + WindowGroup ContentView
    ├── ContentView.swift                   # Text("Relight").padding()
    ├── Info.plist                          # 关键键见 task brief
    └── Assets.xcassets/
        ├── Contents.json                    # {"info":{"version":1,"author":"xcode"}}
        └── AppIcon.appiconset/
            └── Contents.json                # 占位 appiconset（无 PNG，xcodebuild warning 但不报错）
```

**关于 AppIcon**：本任务只声明 `Contents.json` 的 appiconset 结构，实际 PNG 不生成（避免引入二进制资源审查）。xcodebuild 会输出 warning"icon set has no content"但不影响构建成功。

### Monorepo 集成

- pnpm-workspace.yaml 已含 `apps/*` 通配（无需修改）
- turbo.json 已有 `build` 任务，apps/mac 的 `pnpm build` 调用 xcodebuild（不缓存输出，因为 outputs 字段不匹配 Xcode 的 build/ 目录结构 —— 这没关系，只是少了缓存优化）
- biome lint 默认只匹配 ts/tsx/js/jsx/json/css/md，不会触碰 .swift / .pbxproj
- lint-staged glob 同上，不会触碰 swift

### 验证方案

#### 真实测试场景（QA 阶段必跑）

1. **场景 A — xcodebuild 编译通过**（独立）：
   ```bash
   cd apps/mac && xcodebuild -project Relight.xcodeproj -scheme Relight -configuration Debug build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO -derivedDataPath ./build
   ```
   预期：退出码 0，`build/Build/Products/Debug/Relight.app` 存在

2. **场景 B — APP 启动出现窗口**：
   ```bash
   open apps/mac/build/Build/Products/Debug/Relight.app && sleep 3
   osascript -e 'tell application "System Events" to get name of every process' | tr ',' '\n' | grep -i Relight
   ```
   预期：osascript 输出包含 `Relight` 进程名（确认 APP 已启动；窗口可见性靠人工或 screencapture 验证）

3. **场景 C — pnpm install 仍通过**（独立）：
   ```bash
   pnpm install
   ```
   预期：退出码 0，无 lockfile 冲突

4. **场景 D — pnpm typecheck 仍通过**（独立）：
   ```bash
   pnpm typecheck
   ```
   预期：退出码 0，不影响 backend / web

5. **场景 E — pnpm --filter 触发 xcodebuild**：
   ```bash
   pnpm --filter @relight/mac build
   ```
   预期：调起 xcodebuild Release 构建，退出码 0

### 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| 手写 .pbxproj 格式错误 → Xcode 拒绝打开 | 中 | 用 macOS 自带 `plutil -lint` 验证；或用 `xcodebuild -list` 早期失败 |
| 不同 Xcode 版本对 .pbxproj `objectVersion` 字段要求不同 | 低 | 用 `objectVersion = 56`（Xcode 14+）；当前 Xcode 26 兼容 |
| AppIcon 缺 PNG 导致归档失败 | 低 | Debug 构建只 warning；任务 007 archive 阶段再补 |
| pnpm install 把 apps/mac/package.json 当 Node 项目误处理 | 低 | package.json 不声明 dependencies，scripts 仅 echo + xcodebuild |

### 范围控制（KISS）
- ❌ 不创建 RelightClient / WallpaperEngine 业务代码（任务 002+）
- ❌ 不配置 entitlements / 沙盒（任务 005/006 都不需要）
- ❌ 不引入第三方 Swift Package
- ❌ 不写单元测试 target（无业务代码可测，任务 002 起再加）

## 实现计划

按依赖顺序逐步执行：

- [ ] 1. 创建目录 `apps/mac/Relight/Assets.xcassets/AppIcon.appiconset/`
- [ ] 2. 写 `apps/mac/.gitignore`
- [ ] 3. 写 `apps/mac/package.json`（@relight/mac + build/lint/format scripts）
- [ ] 4. 写 `apps/mac/Relight/RelightApp.swift`
- [ ] 5. 写 `apps/mac/Relight/ContentView.swift`
- [ ] 6. 写 `apps/mac/Relight/Info.plist`（CFBundleIdentifier / CFBundleDisplayName=拾光 / LSMinimumSystemVersion=13.0 / LSUIElement=false）
- [ ] 7. 写 `apps/mac/Relight/Assets.xcassets/Contents.json`
- [ ] 8. 写 `apps/mac/Relight/Assets.xcassets/AppIcon.appiconset/Contents.json`
- [ ] 9. 写 `apps/mac/Relight.xcodeproj/project.pbxproj`（手写最小骨架，固定 GUID）
- [ ] 10. 写 `apps/mac/README.md`（环境要求 + 构建命令 + 当前状态：脚手架）
- [ ] 11. 跑场景 A：`xcodebuild build` 成功
- [ ] 12. 跑场景 B：`open Relight.app` 启动确认
- [ ] 13. 跑场景 C：`pnpm install` 通过
- [ ] 14. 跑场景 D：`pnpm typecheck` 通过
- [ ] 15. 跑场景 E：`pnpm --filter @relight/mac build` 通过
- [ ] 16. 写 `.autopilot/project/tasks/001-mac-xcode-scaffold.handoff.md`（≤500 字）+ 更新 dag.yaml status: done

## 红队验收测试
(待 implement 阶段填充)

## QA 报告
(待 qa 阶段填充)

## 变更日志
- [2026-05-06T17:06:18Z] autopilot 初始化（brief 模式），任务: 001-mac-xcode-scaffold.md
