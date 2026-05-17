# Handoff — 004-video-to-dynamic-heic

**状态**: done | **commit**: 56307bb | **完成时间**: 2026-05-07

## 实现摘要

视频壁纸引擎就绪。任务 006 (Coordinator) 现在可以根据 `photo.isVideo` 路由到 ImageEngine（003）或 VideoEngine（本任务）。

### 新增文件
- `apps/mac/Relight/WallpaperEngine/VideoFrameExtractor.swift` — AVAssetImageGenerator 均匀抽帧
- `apps/mac/Relight/WallpaperEngine/DynamicHeicBuilder.swift` — ImageIO 写多帧 HEIC + XMP `apple_desktop:h24` plist
- `apps/mac/Relight/WallpaperEngine/VideoWallpaperEngine.swift` — 组合 + 缓存

### 修改
- `RelightError.swift` — 追加 `videoConversionFailed(reason: String, underlying: Error?)`
- `RelightApp.swift` — 追加 `--self-test=heic-schema-probe` 和 `--self-test=video-wallpaper`
- `pbxproj` — GUID 0x57-0x5C

## 关键发现 — XMP plist schema 实证（schema-probe 输出）

`/System/Library/Desktop Pictures/Sonoma.heic`（macOS 系统的真实多帧动态壁纸）schema：

| 字段 | 用途 | 示例值 |
|------|------|--------|
| `apple_desktop:apr` | Appearance（光暗外观，2 帧 light/dark） | `{l: 0, d: 1}` |
| `apple_desktop:h24` | Solar/时间序列（多帧按时间切换） | `{si: 0, ti: [{i,t},...], ap: {l, d}}` |

本任务用 `h24` 模式（16 帧）。完整 plist 结构：

```
{
  "ap": {"l": 0, "d": 8},                                 // appearance
  "si": 0,                                                 // solar angle start (固定 0.0)
  "ti": [                                                  // time info 16 frames
    {"i": 0, "t": 0.0}, {"i": 1, "t": 0.0625}, ...,
    {"i": 15, "t": 0.9375}
  ]
}
```

写入路径：binary plist → base64 → XMP namespace `http://ns.apple.com/namespace/1.0/` 前缀 `apple_desktop`。

## 关键接口（任务 006 必读）

```swift
final class VideoWallpaperEngine: WallpaperEngine {
  init(cache: WallpaperCache = .shared, frameCount: Int = 16, logger: Logger = ...)

  // 实现 WallpaperEngine protocol
  func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL
  // 返回的 URL 是 dynamic-heic/<hash>.heic（不是 sourceURL）
  // photo.isVideo == false → throw wallpaperSetFailed(reason 含 "视频")
  // 缓存命中（<hash>.heic 已存在）→ 跳过抽帧+构建，直接 setDesktopImageURL
}
```

任务 006 路由：
```swift
let engine: WallpaperEngine = photo.isVideo
  ? videoEngine  // VideoWallpaperEngine
  : imageEngine  // ImageWallpaperEngine（003）
let url = try await engine.apply(photo: photo, sourceURL: localURL, on: NSScreen.screens)
```

## QA 验收摘要
- 红队脚本 17/17 ✅ + 1 skip（接口契约 bash 无法黑盒构造）
- 真实视频测试：09728ce3...mp4（49 秒 1280x720 h264）→ 生成 352KB 16 帧 .heic
- 缓存命中：mtime 1778117675 第 2 次跑保持不变
- file 命令验证：`ISO Media, HEIF Image HEVC Main or Main Still Picture Profile`
- pnpm typecheck ✅

## 实施过程修复
红队 C 组首跑 ❌：原 SelfTest 写死读 `iMac Blue.heic`（单帧静态，无 apple_desktop tag）。
修复：改为 fallback 顺序 `Sonoma.heic > Big Sur.heic > iMac Blue.heic`，重新 build + 重跑 → 17/17 ✅。
（按"审查后修改铁律"，重跑了完整红队验收）

## --self-test 用法

```bash
./Relight --self-test=heic-schema-probe         # 探测系统 .heic 真实 schema
./Relight --self-test=video-wallpaper           # 用已知视频 photoId 09728ce3 生成动态壁纸
```

## 已用 GUID 范围
001: 0x18-0x22 / 002: 0x40-0x51 / 003: 0x52-0x56 / **004: 0x57-0x5C**
任务 005 起继续从 0x5D 递增。
