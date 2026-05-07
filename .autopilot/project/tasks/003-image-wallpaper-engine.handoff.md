# Handoff — 003-image-wallpaper-engine

**状态**: done | **commit**: beb684f | **完成时间**: 2026-05-07

## 实现摘要

图片壁纸引擎就绪。下游任务 006（Coordinator）可直接组合 RelightClient + ImageWallpaperEngine 完成"拉取 → 下载 → 设壁纸"完整链路。

### 新增/修改文件
- `apps/mac/Relight/WallpaperEngine/WallpaperEngine.swift` — protocol（10 行）
- `apps/mac/Relight/WallpaperEngine/ImageWallpaperEngine.swift` — 实现（~50 行）
- `apps/mac/Relight/Networking/RelightError.swift` — 追加 `wallpaperSetFailed(reason: String, underlying: Error?)` case
- `apps/mac/Relight/RelightApp.swift` — SelfTest 追加 `case "image-wallpaper"`
- `apps/mac/Relight.xcodeproj/project.pbxproj` — GUID 0x52-0x56
- `apps/mac/image-wallpaper.acceptance.test.sh` — 红队脚本

### 关键接口（任务 004/006 必读）

```swift
protocol WallpaperEngine {
  func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL
}

final class ImageWallpaperEngine: WallpaperEngine {
  init(logger: Logger = ...)
  // photo.isVideo==true → throw wallpaperSetFailed(reason: "ImageEngine 不支持视频", underlying: nil)
  // sourceURL 不存在 → throw wallpaperSetFailed(reason: "源文件不存在: ...", underlying: nil)
  // setDesktopImageURL 失败 → throw wallpaperSetFailed(reason: "screen ... 设置失败", underlying: error)
}
```

**任务 004 (VideoWallpaperEngine)**：实现同一 `WallpaperEngine` protocol，把视频抽帧 → 动态 .heic → setDesktopImageURL。返回 .heic URL（不是 sourceURL）。

**任务 006 (Coordinator)**：根据 `photo.isVideo` 路由到 `imageEngine` 或 `videoEngine`。

## QA 验收摘要
- 红队脚本 10/10 ✅ + 2 skip（D 组接口契约 bash 无法黑盒构造）
- 真实壁纸切换 MD5 验证：baseline `28c636a56cc6781baf3347f19e417ac4` → after `108aaa88a3ed87e22d242df4bf881b79`（不一致 = 壁纸切换成功）
- pnpm typecheck ✅（4 successful, 4 total）

## --self-test 用法

```bash
./Relight.app/Contents/MacOS/Relight --self-test=image-wallpaper
# 退出码：0 = 成功 / 2 = 今日 pick 是 video（跳过） / 1 = 错误
```

## 已用 GUID 范围
001: 0x18-0x22 / 002: 0x40-0x51 / **003: 0x52-0x56**
任务 004 起继续从 0x57 递增。
