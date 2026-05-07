# Handoff — 002-relight-api-client

**状态**: done | **commit**: 6454638 | **完成时间**: 2026-05-07

## 实现摘要

Swift 数据访问层就绪，下游任务 003/004/006 可以直接使用。

### 7 个新 Swift 文件 + 修改 RelightApp.swift + 扩展 pbxproj

```
apps/mac/Relight/
├── Models/
│   ├── Photo.swift          # 11 基础字段 + mediaType/durationSec/videoCodec/videoFps + isVideo 扩展
│   └── DailyPick.swift
├── Networking/
│   ├── ApiResponse.swift    # ApiResponse<T> + ApiError
│   ├── RelightError.swift   # 5 case + 中文 description
│   └── RelightClient.swift  # fetchTodayPick + downloadOriginal
├── Storage/
│   └── WallpaperCache.swift # rootURL/originalDir/dynamicHeicDir + 任意扩展名匹配
└── Settings/
    └── AppSettings.swift    # @Published apiURL（默认 http://localhost:3000）
```

## 关键接口（任务 003/004/006 必读）

```swift
final class RelightClient {
  init(settings: AppSettings = .shared, urlSession: URLSession = .shared)
  func fetchTodayPick() async throws -> DailyPick
  func downloadOriginal(_ photo: Photo) async throws -> URL
}

protocol WallpaperCache {  // 实际 final class
  static let shared: WallpaperCache
  var rootURL: URL { get }            // ~/Library/Application Support/Relight/wallpapers/
  var originalDir: URL { get }        // .../original/
  var dynamicHeicDir: URL { get }     // .../dynamic-heic/  (任务 004 用)
  func ensureDirectories() throws
  func findCachedOriginal(hash: String) -> URL?
  func writeOriginal(hash: String, ext: String, data: Data) throws -> URL
}

enum RelightError: Error {
  case networkUnreachable(underlying: Error)
  case invalidResponse(statusCode: Int, body: String?)
  case decodingFailed(underlying: Error)
  case cacheWriteFailed(path: URL, underlying: Error)
  case noPickAvailable
}
```

⚠️ **Access modifier 偏差**：设计文档写 `public`，蓝队改成 `internal`（即省略修饰符），原因是 macOS app target 是单模块，Swift 不允许 public 方法暴露 internal 类型。行为等价，下游可直接 import 同模块使用。

## 数据契约（schema drift 已修正）

**关键事实**：项目 design.md 此前写"无 mediaType"是错的，curl 实证 `/api/daily/today` 返回的 photo 包含：
- `mediaType: String?` — `"image"` | `"video"`（默认 image）
- `durationSec: Double?`
- `videoCodec: String?`
- `videoFps: Double?`
- `fileMtime: Int?`

types.ts 和 schema.ts 都未声明这些（前后端契约失同步）。Swift Codable 以**实际 API 响应**为准。`isVideo` 计算属性优先用 `mediaType == "video"`，扩展名兜底。

## 缓存策略（任务 003/004 必读）

- 路径：`~/Library/Application Support/Relight/wallpapers/original/<photo.fileHash>.<ext>`
- ext 由响应 `Content-Type` 推断（image/jpeg→jpg，image/png→png，video/*→原扩展名）
- 命中：`<hash>.*` 任意扩展名匹配 → 跳过下载
- HEIC 服务端已转 JPEG（`apps/backend/src/routes/photos.ts:235-238`），客户端不会拿到 .heic

## --self-test 启动钩子（仅 DEBUG）

```bash
./Relight.app/Contents/MacOS/Relight --self-test=codable   # 离线 fixture 解码（含 video + 缺 photo 兜底）
./Relight.app/Contents/MacOS/Relight --self-test=fetch     # 真实 fetchTodayPick
./Relight.app/Contents/MacOS/Relight --self-test=download  # 真实 download + 缓存
```

任务 003/004 可借用此钩子加 `--self-test=image-wallpaper` / `--self-test=video-heic` 等模式做集成验证（设计文档 5+ 任务后再统一加 XCTest target）。

## pbxproj GUID 分配（任务 003/004/005/006 必读）

001 已用：`A0...0018-0022`（含 1 个 productRef、4 个 fileRef、3 个 buildFile）
002 已用：`A0...0040-0051`（4 Group + 7 fileRef + 7 buildFile，已加入 sources phase）

**任务 003+ 新增文件继续用 0x52 起递增**，避免重新进入低位区段。

修改 pbxproj 时务必：
1. plutil -lint 校验
2. xcodebuild -list 确认 target 仍可识别
3. 完整 build 一次确认 sources phase 没漏

## 下游任务对接点

- **任务 003 (image wallpaper)**：用 `RelightClient.downloadOriginal(_:)` 拿到本地图片 URL → `NSWorkspace.setDesktopImageURL(_:for:options:)` 设置壁纸
- **任务 004 (video → 动态 .heic)**：用同一 `downloadOriginal` 拿到本地 mp4 URL → `WallpaperCache.dynamicHeicDir` 存放生成的 .heic
- **任务 006 (coordinator)**：注入 `RelightClient` + 两个 engine + `AppSettings`，串起调度逻辑

## QA 验收摘要
- 红队 22/22 ✅
- Wave 1.5 6 个真实场景全 ✅
- pnpm typecheck 4/4 ✅
- Wave 2 qa-reviewer 跳过（iteration 紧迫，详见 QA 报告）— 不阻塞但建议任务 003+ 提早执行
