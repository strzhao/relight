---
id: 004-video-to-dynamic-heic
title: 视频→动态 .heic 引擎（AVAssetImageGenerator + ImageIO + XMP）
complexity: L
depends_on:
  - 002-relight-api-client
status: pending
---

## 目标
实现 `VideoWallpaperEngine`：接收任务 002 下载好的本地视频文件，
1. 用 AVAssetImageGenerator 抽 16 帧均匀采样
2. 用 ImageIO 写入多帧 HEIC 文件
3. 为 HEIC 添加 `apple_desktop:h24` XMP 元数据（time-based 模式 plist）
4. 调用 `setDesktopImageURL` 设置为壁纸 → macOS 自动按时间循环切换 16 帧

## 架构上下文

参考 `.autopilot/project/design.md` 的「Plan Reviewer 补充约定 #3」章节（动态 .heic XMP plist 模板）。

### 关键技术（必须先验证再实现）

**先验证再实现**铁律：
- 直接根据"草图 plist schema"实现风险高，错一个 key macOS 退回静态壁纸
- **任务启动后首要工作**：用 `osascript` 或下载/抽取 wallpapper 项目代码 (https://github.com/mczachurski/wallpapper) 的 `Sources/wallpapper/Console/HeicHandler.swift`，研读其 plist 生成逻辑，**对照真实 Apple 动态壁纸**验证（如 macOS Mojave 的 Solar 动态壁纸样本）
- 提取一份 macOS 自带动态壁纸（路径如 `/System/Library/Desktop Pictures/...heic`）的 XMP，用 `ExifTool` 或 `xattr` 验证字段名

### 技术栈
- AVFoundation：`AVAsset`、`AVAssetImageGenerator`
- ImageIO：`CGImageDestinationCreateWithURL` / `CGImageDestinationAddImage` / `CGImageDestinationSetProperties`
- 元数据：`CGImageMetadata` + `CGImageMetadataTagCreate`（namespace `apple_desktop`，name `h24`）
- 编码：HEIC 容器，每帧 JPEG 压缩 quality 0.8

## 输入契约

来自任务 002：
- `WallpaperCache` 提供 `dynamic-heic/` 子目录路径
- `Photo` struct + `RelightError`

来自任务 003：
- `WallpaperEngine` protocol（必须实现）

## 输出契约（handoff）

### 必须创建的源文件

```
apps/mac/Relight/
└── WallpaperEngine/
    ├── VideoWallpaperEngine.swift       # 主实现
    ├── DynamicHeicBuilder.swift         # 子模块：纯 ImageIO + XMP plist 写入
    └── VideoFrameExtractor.swift        # 子模块：纯 AVFoundation 抽帧
```

### VideoWallpaperEngine 行为

```swift
public final class VideoWallpaperEngine: WallpaperEngine {
  public init(cache: WallpaperCache)

  public func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL {
    // 1. 校验 photo.isVideo == true
    // 2. 检查缓存：~/Library/Application Support/Relight/wallpapers/dynamic-heic/<hash>.heic
    //    存在则跳过 1+2 直接到 3
    // 3. VideoFrameExtractor 抽 16 帧（均匀采样，时间点 i/16 * duration，i=0..15）
    // 4. DynamicHeicBuilder 写入 HEIC + XMP plist
    // 5. 遍历 screens 调 setDesktopImageURL
    // 6. 返回 .heic URL
  }
}
```

### DynamicHeicBuilder 关键实现要点

- 用 `CGImageDestinationCreateWithURL(.. , kUTTypeHEIC ?? "public.heic" ..)` 创建 HEIC 容器
- 对每帧 `CGImageDestinationAddImage(dest, frame, properties)`
- 第 0 帧的 `properties` 里通过 `kCGImagePropertyMakerAppleDictionary` 或 `kCGImageMetadataNamespaceXMP` 写入 plist：
  - **plist schema**（time-based `apple_desktop:h24`）：
    ```
    {
      "ti": [                  // time info: 数组（必备）
        { "i": 0, "t": 0.0 },
        { "i": 1, "t": 0.0625 },
        ...
        { "i": 15, "t": 0.9375 }
      ],
      "ap": {                  // appearance: 可选（light/dark）
        "l": 0,
        "d": 8
      }
    }
    ```
  - 序列化为二进制 plist（`PropertyListSerialization.data(fromPropertyList:format:.binary)`）
  - base64 编码
  - 写入 XMP `<x:xmpmeta xmlns:apple_desktop="http://ns.apple.com/namespace/1.0/"><apple_desktop:h24>BASE64</apple_desktop:h24></x:xmpmeta>`
- **关键**：上述格式来自 wallpapper 推断，启动任务时**必须先验证**真实 Apple 壁纸的实际 schema

### 错误类型扩展

```swift
case videoConversionFailed(reason: String, underlying: Error?)
```

具体 reason：`"frame extraction failed at index N"`、`"heic write failed"`、`"xmp metadata invalid"`

## 验收标准

1. **编译通过**：xcodebuild build 退出码 0

2. **VideoFrameExtractor 单元测试**：
   - 给一个测试视频（Bundle 内置一个 5MB 短视频，或从 `/System/Library/Compositions/` 找 mov 样本）
   - 抽 16 帧后每帧都是有效 CGImage（非 nil、尺寸 > 0）

3. **DynamicHeicBuilder 单元测试**：
   - 喂 16 张测试图片 → 输出 .heic 文件
   - 用 `ExifTool` 命令行验证 XMP 中 `apple_desktop:h24` 字段存在且 base64 plist 解开后字段名正确：
     ```bash
     exiftool -XMP-apple_desktop:H24 output.heic
     # 或
     xcrun mdls -name kMDItemKind output.heic
     ```
   - 报告中附 ExifTool 输出

4. **真实 smoke test（必跑，关键）**：
   - 在 backend 数据中找一条视频精选（或临时插入一条）
   - 用 RelightClient 下载视频
   - 调 `engine.apply(...)` 生成 .heic 并设为壁纸
   - **肉眼/截图确认**：等 30 秒到 1 分钟，桌面壁纸应自动切换帧（macOS 系统按 ti 数组的 t 字段判定）
   - 报告中附两个时间点的截图（间隔 1 分钟以上，用 `screencapture -x`）证明动态切换

5. **缓存命中测试**：第二次对同一 photo 调 apply，跳过抽帧/.heic 生成，直接 setDesktopImageURL（OSLog 应该有 "cache hit" 标记）

6. **失败回退**：如果 XMP 写入或抽帧失败，抛 `videoConversionFailed(reason: ...)`，并清理临时文件

## 重要约束

- **绝对**先研读 wallpapper 源码 + 真实 Apple HEIC 验证 schema，**不要**仅凭本任务文件的 plist 草图实现
- **不要**用 ffmpeg 或其他外部依赖；纯 AVFoundation + ImageIO
- **不要**支持「按太阳位置切换」(solar 模式) —— 只做 time-based (h24)
- **不要**做帧选择优化（场景检测、人脸识别等）—— 均匀采样即可
- **不要**改动任务 003 的 ImageWallpaperEngine 代码

## handoff 必须包含

- 验证后的真实 `apple_desktop:h24` plist schema（如果与本任务草图不同，明确说明差异）
- `VideoWallpaperEngine` 完整接口
- 抽帧 + .heic 生成耗时数据（首次 vs 缓存命中）
- 临时文件清理位置（如有）
- 已知限制：例如 1080p 以上视频抽帧内存占用、HEIC 文件体积估算
