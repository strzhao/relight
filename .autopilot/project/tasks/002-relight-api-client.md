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

3. **真实 smoke test**（必跑，附输出）：
   ```bash
   # 启动 backend
   cd /Users/stringzhao/workspace/relight/.claude/worktrees/mac
   pnpm --filter @relight/backend dev &
   # 等 backend 起来
   sleep 8
   curl http://localhost:3000/api/daily/today
   # 应返回 { "data": { ... DailyPick ... } } 或类似
   ```
   然后写一个简单 CLI 测试入口（如 `RelightApp.swift` 内 #if DEBUG 的 startup hook 或 XCTest 异步测试），调用 `client.fetchTodayPick()` + `client.downloadOriginal(...)`，确认本地缓存目录出现文件，OSLog 打印结果。

   报告中必须附 curl 命令真实输出 + Swift 调用产生的 OSLog 日志。

4. **缓存命中测试**：第二次调用 `downloadOriginal(samePhoto)` 不发起 HTTP 请求（用 URLSession mock 或简单计数器验证）

5. **错误路径**：故意把 apiURL 改成 `http://localhost:9999`，调用 `fetchTodayPick()` 抛出 `RelightError.networkUnreachable`

## 重要约束

- **不要**实现任何壁纸设置逻辑 —— 那是 003、004
- **不要**实现菜单栏 / 设置 UI —— 那是 005
- **不要**引入第三方 SDK（Alamofire、Moya 等），用纯 URLSession + async/await
- **必须**先用 curl 验证一次 `/api/daily/today` 实际响应再写 Codable struct，**不要**仅凭 types.ts 推断
- **必须**提供 OSLog `os.Logger(subsystem: "app.relight.mac", category: "network")` 日志便于调试

## handoff 必须包含

- `RelightClient.swift` 完整接口签名（公开方法 + RelightError 全部 case）
- `DailyPick`/`Photo` 完整字段列表（含 `fileMtime` 等已加但未在 types.ts 中的字段）
- 缓存目录绝对路径
- 错误类型每个 case 的触发条件
- Settings 当前已支持的 Key（仅 `app.relight.apiURL`，其他留给后续任务）
