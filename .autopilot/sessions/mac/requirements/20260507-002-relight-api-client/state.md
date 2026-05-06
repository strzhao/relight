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
brief_file: "/Users/stringzhao/workspace/relight/.autopilot/project/tasks/002-relight-api-client.md"
next_task: ""
auto_approve: true
knowledge_extracted: ""
task_dir: "/Users/stringzhao/workspace/relight/.claude/worktrees/mac/.autopilot/sessions/mac/requirements/20260507-002-relight-api-client"
session_id: 
started_at: "2026-05-06T17:30:36Z"
---

## 目标
---
id: 002-relight-api-client
title: Swift RelightClient（拉 daily + 下载 original + 本地缓存）
complexity: M
depends_on:
  - 001-mac-xcode-scaffold
status: pending
---

## 目标
实现 Swift `RelightClient` 类，封装与 Relight 后端的 HTTP 通信：
1. `GET /api/daily/today` 获取今日 `DailyPick`（含关联 `Photo`）
2. `GET /api/photos/:id/original` 下载原始文件并缓存到本地
3. 本地缓存目录管理：`~/Library/Application Support/Relight/wallpapers/original/`

## 架构上下文

参考 `.autopilot/project/design.md` 的「数据契约」「缓存目录约定」章节。本任务为后续壁纸引擎（任务 003、004）和调度协调器（任务 006）提供数据访问层。

### 关键事实（必须知晓）

1. **API URL 来源**：从 UserDefaults `app.relight.apiURL` 读取，默认 `http://localhost:3000`（任务 005 提供 Settings UI，本任务先用一个简单读取函数）

2. **Photo 字段以 API 实际响应为准**：`packages/shared/src/types.ts` 未声明 `fileMtime`，但 `apps/backend/src/routes/daily.ts` 的 select * 实际会返回该字段（DB schema 含此字段）。Swift `Photo` struct 必须包含 `fileMtime: Int?`。

3. **HEIC 服务端转码**：`apps/backend/src/routes/photos.ts` 第 235-238 行显示 HEIC 文件经 `/api/photos/:id/original` 下载时已被服务端转为 JPEG，`Content-Type` 变成 `image/jpeg`。本任务必须根据**实际响应 Content-Type** 决定缓存文件扩展名，而非 `photo.filePath` 原扩展名。

4. **CORS / 认证**：后端无认证、全局 CORS，简单 URLSession 即可。

5. **响应包装格式**：检查 backend 的统一响应格式，`/api/daily/today` 实际返回 `{ "data": DailyPick }` 包装结构 —— 解码时需先解 `ApiResponse<DailyPick>` 再取 `.data` 字段。**实现前先用 curl 验证一次实际响应**。

## 输入契约
- 已完成的 Xcode 工程：`apps/mac/Relight.xcodeproj`
- 后端可用：用户在 worktree 中跑 `pnpm --filter @relight/backend dev` 启动（端口可能是 3000 / 4001 等）

## 输出契约（handoff）

### 必须创建的源文件

```
apps/mac/Relight/
├── Models/
│   ├── DailyPick.swift          # Codable struct
│   └── Photo.swift               # Codable struct + isVideo 扩展
├── Networking/
│   ├── RelightClient.swift       # 主 API 客户端
│   ├── RelightError.swift        # 统一错误类型
│   └── ApiResponse.swift         # 通用包装类型 ApiResponse<T: Codable>
├── Storage/
│   └── WallpaperCache.swift      # 缓存目录管理
└── Settings/
    └── AppSettings.swift          # UserDefaults 包装（仅 apiURL 一项即可，autoStart/lastAppliedPickDate 留给任务 005、006）
```

### RelightClient 接口

```swift
public final class RelightClient {
  public init(settings: AppSettings = .shared, urlSession: URLSession = .shared)

  /// 拉取今日精选；如果当天还未生成，可能返回 nil（后端规则）
  public func fetchTodayPick() async throws -> DailyPick

  /// 下载原始文件到本地缓存，返回缓存文件 URL
  /// - Parameter photo: 来自 DailyPick.photo
  /// - Returns: 本地文件 URL（已下载/已存在缓存）
  public func downloadOriginal(_ photo: Photo) async throws -> URL
}
```

### 缓存策略
- 命名：`<photo.fileHash>.<ext>`，其中 `ext` 由响应 `Content-Type` 推断：
  - `image/jpeg` → `.jpg`
  - `image/png` → `.png`
  - `image/heic` → `.heic`（理论上不会出现，因服务端会转）
  - `video/mp4` → `.mp4`
  - 其他 video/* → 取 `photo.filePath` 原扩展名
- **缓存命中**：如果 `<hash>.*` 文件已存在则直接返回本地 URL，跳过下载
- **缓存淘汰**：本任务不实现，留给任务 006

### RelightError enum（精确字符串）

```swift
public enum RelightError: Error {
  case networkUnreachable(underlying: Error)
  case invalidResponse(statusCode: Int, body: String?)
  case decodingFailed(underlying: Error)
  case cacheWriteFailed(path: URL, underlying: Error)
  case noPickAvailable           // /api/daily/today 返回空（DailyPick 不存在）
}
```

## 验收标准

1. **编译通过**：xcodebuild build 退出码 0

2. **Codable 单元测试**（XCTest）：
   - 提供一个真实 `/api/daily/today` 响应 JSON 样本作为 fixture
   - 解码后字段值符合预期（`pickDate`、`photo.fileHash` 等）
   - 缺失 `photo` 字段时不崩溃（设为 nil）


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
(待 design 阶段填充)

## 实现计划
(待 design 阶段填充)

## 红队验收测试
(待 implement 阶段填充)

## QA 报告
(待 qa 阶段填充)

## 变更日志
- [2026-05-06T17:30:36Z] autopilot 初始化（brief 模式），任务: 002-relight-api-client.md
