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
```

## 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| **macOS 最低版本** | 13.0 Ventura | SMAppService、Metal Shader 等 API 要求；2026 年 95%+ Mac 已升级 |
| **Bundle ID** | `app.relight.mac` | 与项目品牌一致 |
| **签名** | ad-hoc Sign to Run Locally（MVP） | 用户当前无 Apple Developer 账号需求，dev 自用 |
| **沙盒** | 关闭 | Application Support 写入 + 视频解码权限不必走沙盒，简化集成 |
| **媒体类型判定** | 客户端依扩展名（`.mp4/.mov/.avi/.mkv/.webm/.m4v` 视频，其余图片） | 后端 photos 表无 mediaType 字段，与现有 backend 行为一致 |
| **API URL 默认值** | `http://localhost:3000` | 与主仓库 backend 默认端口一致；用户可在设置中改成 worktree 端口 |
| **HEIC 模式** | `apple_desktop:h24` (time-based) | Solar 模式需要算太阳高度角太复杂；time-based 24h 均匀分布 16 帧足够 |
| **抽帧数** | 16 帧 | 与 Apple 原生 Mojave 动态壁纸一致，体积可控 |

## 跨任务设计约束

1. **命名规范**：Swift 类型用 PascalCase（`DailyPick`、`RelightClient`、`WallpaperCoordinator`）；模块使用 SwiftUI 标准做法 —— 不引入第三方 DI 容器
2. **错误处理**：定义统一的 `RelightError` enum（`networkUnreachable`、`decodingFailed`、`videoConversionFailed`、`wallpaperSetFailed`），通过 throws 传递；UI 层用 `@State var lastError` 展示
3. **类型对齐**：`packages/shared/src/types.ts` 中的 `DailyPick`/`Photo` 字段必须 1:1 映射到 Swift Codable struct（实际以 API 响应为准，含 schema 中存在但 types.ts 未声明的 `fileMtime` 字段）
4. **共享接口**：`WallpaperEngine` protocol 定义 `func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL`，让 `ImageWallpaperEngine` 和 `VideoWallpaperEngine` 可互换
5. **日志**：用 OSLog（`os.Logger(subsystem: "app.relight.mac", category: ...)`)，不引入第三方日志库
6. **测试**：每个核心组件附带 XCTest 单元测试，但 macOS 系统集成（setDesktopImageURL、SMAppService）以集成 smoke test 通过为准

## 数据契约

```swift
// 必须与 packages/shared/src/types.ts 1:1 对齐（实际以 API 响应为准）
struct DailyPick: Codable, Identifiable {
  let id: String
  let photoId: String
  let pickDate: String      // "YYYY-MM-DD" (北京时间)
  let title: String
  let narrative: String
  let score: Double
  let createdAt: String
  let photo: Photo?
}

struct Photo: Codable, Identifiable {
  let id: String
  let storageSourceId: String
  let filePath: String      // 用于扩展名识别媒体类型
  let fileHash: String
  let width: Int
  let height: Int
  let fileSize: Int
  let thumbnailPath: String?
  let takenAt: String?
  let fileMtime: Int?       // schema 含此字段，types.ts 未声明
  let createdAt: String
}

extension Photo {
  var isVideo: Bool {
    let ext = (filePath as NSString).pathExtension.lowercased()
    return ["mp4", "mov", "avi", "mkv", "webm", "m4v"].contains(ext)
  }
}
```

## 缓存目录约定

```
~/Library/Application Support/Relight/
├── wallpapers/
│   ├── original/          # 任务 002 下载的原始文件 (file_hash 命名)
│   └── dynamic-heic/      # 任务 004 生成的动态 .heic
└── state.json             # 最近一次成功设置的 pickDate / photoId（任务 006 维护）
```

缓存命名根据**实际响应 Content-Type** 决定扩展名：HEIC 经服务端转码后已是 JPEG，命名 `<hash>.jpg`；其他按响应 Content-Type 推断。

## UserDefaults Key

| Key | 类型 | 默认值 | 用途 |
|-----|------|--------|------|
| `app.relight.apiURL` | String | `http://localhost:3000` | 后端 API 基础地址 |
| `app.relight.autoStart` | Bool | `false` | 登录时自启动 |
| `app.relight.lastAppliedPickDate` | String? | nil | 防止当天重复设置 |

## 整体 MVP 验收（007 完成后执行）

1. 启动 backend（`pnpm --filter @relight/backend dev`）→ 确认 `/api/daily/today` 返回数据
2. 启动 Relight.app → 菜单栏图标出现
3. 点「立即更新」→ 桌面壁纸切换为今日精选
4. 在设置中切到一条视频精选 → 触发更新 → 桌面进入动态 .heic 模式（macOS 自动按时间切换帧）
5. 重启电脑 → 自启动开关启用时 APP 自动启动并刷新壁纸

## 后续扩展（不在本项目范围）

- 多 daily-pick 历史壁纸轮换
- Sonoma Live Wallpaper 文件夹方案（私有路径）
- Apple Developer 账号 + Notarize 分发
- 自动检测后端进程是否在运行（mac mDNS / launchd 探测）
- 在通知中心展示 narrative 文案
