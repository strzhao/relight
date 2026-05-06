---
id: 003-image-wallpaper-engine
title: 图片壁纸引擎（多显示器 setDesktopImageURL）
complexity: M
depends_on:
  - 002-relight-api-client
status: pending
---

## 目标
实现 `ImageWallpaperEngine`：接收任务 002 下载好的本地图片文件，把它设置为 macOS 桌面壁纸，覆盖所有连接的显示器。

## 架构上下文

参考 `.autopilot/project/design.md` 的「整体架构设计」「跨任务设计约束」章节。

### 关键事实
- macOS API：`NSWorkspace.shared.setDesktopImageURL(_:for:options:)`
- 多显示器：遍历 `NSScreen.screens`，对每个 screen 调用一次
- macOS 已知 bug：若同一 URL 文件内容被覆盖更新，setDesktopImageURL 可能不刷新缓存。本任务的图片直接来自任务 002 的 `<hash>.<ext>` 缓存（hash 唯一）—— 内容不会被覆盖，无此问题
- 支持的图片格式：JPEG / PNG / HEIC（macOS 原生支持，可直接 setDesktopImageURL）

## 输入契约

来自任务 002：
- `WallpaperCache` 提供本地缓存路径
- `Photo` struct（含 `isVideo` 扩展）

`apply(photo:sourceURL:on:)` 的 `sourceURL` 是任务 002 `RelightClient.downloadOriginal(_:)` 返回的本地文件 URL。

## 输出契约（handoff）

### 必须创建的源文件

```
apps/mac/Relight/
└── WallpaperEngine/
    ├── WallpaperEngine.swift            # protocol 定义
    └── ImageWallpaperEngine.swift       # 图片实现
```

### Protocol 定义（最终版）

```swift
public protocol WallpaperEngine {
  /// 把 photo 设为壁纸，覆盖所有指定屏幕
  /// - Parameters:
  ///   - photo: DailyPick.photo
  ///   - sourceURL: 任务 002 缓存的本地文件 URL
  ///   - screens: 要设置的屏幕列表（默认 NSScreen.screens）
  /// - Returns: 实际设置成功的壁纸文件 URL（图片引擎直接返回 sourceURL；视频引擎返回生成的 .heic URL）
  func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL
}
```

### ImageWallpaperEngine 行为

1. **前置校验**：
   - `photo.isVideo == false`，否则抛 `RelightError.wallpaperSetFailed(reason: "ImageEngine 不支持视频")`
   - `sourceURL` 文件存在且可读
2. **遍历屏幕**：
   ```swift
   for screen in screens {
     try NSWorkspace.shared.setDesktopImageURL(sourceURL, for: screen, options: [:])
   }
   ```
3. **失败处理**：任何屏幕设置失败立即抛错，不做半成功状态（不容易回滚到旧壁纸）
4. **日志**：OSLog `category: "wallpaper.image"` 打印每个屏幕的 localizedName 和最终 URL

### RelightError 扩展

任务 002 已定义 RelightError，本任务追加：
```swift
case wallpaperSetFailed(reason: String, underlying: Error?)
```

## 验收标准

1. **编译通过**：xcodebuild build 退出码 0

2. **接口契约单元测试**（XCTest）：
   - `apply(photo: video, ...)` 抛 `wallpaperSetFailed`（reason 包含 "视频"）
   - `apply(photo: image, sourceURL: 不存在路径, ...)` 抛 `wallpaperSetFailed`

3. **真实 smoke test（关键，必跑，附截图或终端输出）**：
   - 启动 backend，调任务 002 的 RelightClient 拉取一张图片精选
   - 把当前桌面壁纸切到一张明显不同的图片（如纯色），便于验证
   - 调用 `engine.apply(photo:..., sourceURL:..., on: NSScreen.screens)`
   - **肉眼确认**桌面壁纸已切换为目标照片
   - 在 QA 报告中附 `screencapture -x` 截图（保存到 `/tmp/wallpaper-after.png`）+ OSLog 输出

   验收命令示例：
   ```bash
   # 在测试 target 中跑
   xcodebuild test -project apps/mac/Relight.xcodeproj -scheme Relight \
     -destination 'platform=macOS' -only-testing:RelightTests/ImageWallpaperEngineTests/testApplyImageToScreen
   # 然后人工确认壁纸是否切换
   screencapture -x /tmp/wallpaper-after.png
   ```

4. **多显示器测试**（如有外接显示器）：所有屏幕都切换；如只有内置屏，跳过此项但在 QA 报告中说明

5. **回退性**：如果 `setDesktopImageURL` 抛异常，OSLog 必须记录原始错误信息

## 重要约束

- **不要**实现视频处理逻辑 —— 视频抛 `wallpaperSetFailed` 让 Coordinator 路由到 VideoEngine
- **不要**做下载 / 缓存 —— 那是任务 002 的职责
- **不要**实现自动选择当前屏幕的逻辑：调用方传 `NSScreen.screens` 即可
- **不要**做"壁纸更换动画"等过度设计

## handoff 必须包含

- `WallpaperEngine` protocol 完整签名（这是 003、004 共享的契约）
- `ImageWallpaperEngine` 完整接口
- 已知限制（如不支持视频）
- 多显示器行为说明
