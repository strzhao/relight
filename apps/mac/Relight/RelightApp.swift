import SwiftUI
import OSLog
import ImageIO
import Network
import UserNotifications

@main
struct RelightApp: App {
    @StateObject private var settings = AppSettings.shared
    @StateObject private var commandBus = MenuBarCommandBus()
    @StateObject private var healthMonitor = MenuBarHealthMonitor()

    fileprivate static let logger = Logger(subsystem: "app.relight.mac", category: "RelightApp")

    // 单例式持有 coordinator，避免 actor 在 init 内被 capture self 问题
    fileprivate static var sharedCoordinator: WallpaperCoordinator?

    init() {
        #if DEBUG
        let args = CommandLine.arguments
        if let mode = args.first(where: { $0.hasPrefix("--self-test=") })?
            .split(separator: "=", maxSplits: 1).last.map(String.init) {
            Task.detached { await SelfTest.run(mode: mode) }
            return  // self-test 模式下不构建调度器
        }
        #endif

        // 构建依赖图（仅生产路径执行）
        let cache = WallpaperCache.shared
        try? cache.ensureDirectories()
        let coordinator = WallpaperCoordinator(
            client: RelightClient(),
            imageEngine: ImageWallpaperEngine(),
            videoEngine: VideoWallpaperEngine(cache: cache),
            settings: AppSettings.shared,
            aerialEngine: AerialVideoEngine()
        )
        let autostart = AutostartManager()
        Self.sharedCoordinator = coordinator

        // 直接在 init 中设置回调
        commandBus.onRefreshNow = { [coordinator] in
            await coordinator.refreshNow()
        }
        commandBus.onAutoStartChange = { [autostart] en in
            autostart.sync(enabled: en)
        }

        // 启动 bootstrap + scheduler
        Task.detached {
            await coordinator.bootstrapOnLaunch()
            await coordinator.startScheduler()
        }

        // 启动时请求通知权限（壁纸更新结果需要通知用户）
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error = error {
                Self.logger.error("通知权限请求失败: \(error.localizedDescription)")
            } else if granted {
                Self.logger.info("通知权限已授予")
            } else {
                Self.logger.warning("通知权限被拒绝")
            }
        }

        // 启动时同步 autostart 状态（首次注册可能弹系统授权）
        autostart.sync(enabled: AppSettings.shared.autoStart)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent()
                .environmentObject(commandBus)
                .onAppear {
                    healthMonitor.start()
                }
        } label: {
            Image(systemName: healthMonitor.iconName)
                .renderingMode(.template)
                .accessibilityLabel(healthMonitor.accessibilityLabel)
        }
        Window("拾光 — 控制中心", id: "control-center") {
            ControlCenterView()
                .environmentObject(settings)
                .environmentObject(commandBus)
        }
    }
}

#if DEBUG
enum SelfTest {
    static let logger = Logger(subsystem: "app.relight.mac", category: "self-test")

    static func run(mode: String) async {
        do {
            switch mode {
            case "codable":
                // fixture1: video mediaType 真实样本
                let fixture1 = #"{"success":true,"data":{"id":"abc123","photoId":"09728ce3-6c07-4389-a9c1-f22d12f9f297","pickDate":"2026-05-07","title":"测试标题","narrative":"测试叙事文案内容","score":8.5,"createdAt":"2026-05-06T16:33:58.488Z","photo":{"id":"09728ce3-6c07-4389-a9c1-f22d12f9f297","storageSourceId":"af04a135-16c9-4231-b231-60292a44f4ad","filePath":"/tmp/test.mp4","fileHash":"4c81094babcdef","width":1280,"height":720,"fileSize":3924357,"thumbnailPath":null,"takenAt":null,"fileMtime":null,"createdAt":"2026-05-06T16:00:00.000Z","mediaType":"video","durationSec":49.1,"videoCodec":"h264","videoFps":30.0}}}"#
                // fixture2: photo 为 null
                let fixture2 = #"{"success":true,"data":{"id":"def456","photoId":"00000000-0000-0000-0000-000000000001","pickDate":"2026-05-07","title":"无photo","narrative":"测试无照片场景","score":7.0,"createdAt":"2026-05-06T16:33:58.488Z","photo":null}}"#
                let dec = JSONDecoder()
                let r1 = try dec.decode(ApiResponse<DailyPick>.self, from: Data(fixture1.utf8))
                precondition(r1.data?.photo?.isVideo == true, "fixture1 photo should be video")
                let r2 = try dec.decode(ApiResponse<DailyPick>.self, from: Data(fixture2.utf8))
                precondition(r2.data?.photo == nil, "fixture2 photo should be nil")
                print("[self-test] codable: ok (2 fixtures)")
                logger.info("codable: ok (2 fixtures)")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)
            case "fetch":
                let pick = try await RelightClient().fetchTodayPick()
                print("[self-test] pick: \(pick.pickDate) photo=\(pick.photo?.id ?? "nil") mediaType=\(pick.photo?.mediaType ?? "nil")")
                logger.info("pick: \(pick.pickDate) photo=\(pick.photo?.id ?? "nil") mediaType=\(pick.photo?.mediaType ?? "nil")")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)
            case "download":
                let pick = try await RelightClient().fetchTodayPick()
                guard let photo = pick.photo else {
                    print("[self-test] no photo in pick")
                    logger.error("no photo")
                    try await Task.sleep(for: .milliseconds(100))
                    exit(1)
                }
                let url = try await RelightClient().downloadOriginal(photo)
                print("[self-test] download done: \(url.path)")
                logger.info("download done: \(url.path)")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)
            case "heic-schema-probe":
                // 优先用 Sonoma.heic（多帧动态壁纸，含 apple_desktop:apr metadata），fallback 到 iMac Blue
                let candidates = [
                    "/System/Library/Desktop Pictures/Sonoma.heic",
                    "/System/Library/Desktop Pictures/Big Sur.heic",
                    "/System/Library/Desktop Pictures/iMac Blue.heic",
                ]
                let heicURL = URL(fileURLWithPath: candidates.first { FileManager.default.fileExists(atPath: $0) } ?? candidates.last!)
                print("[schema-probe] reading: \(heicURL.path)")
                guard let src = CGImageSourceCreateWithURL(heicURL as CFURL, nil) else {
                    print("[schema-probe] failed to open: \(heicURL.path)")
                    exit(1)
                }
                let count = CGImageSourceGetCount(src)
                print("[schema-probe] frame count: \(count)")
                // 遍历每帧的 metadata
                for frameIdx in 0..<min(count, 3) {
                    print("[schema-probe] --- frame \(frameIdx) ---")
                    if let metadata = CGImageSourceCopyMetadataAtIndex(src, frameIdx, nil) {
                        if let tags = CGImageMetadataCopyTags(metadata) as? [CGImageMetadataTag] {
                            print("[schema-probe] tag count: \(tags.count)")
                            for tag in tags {
                                let prefix = (CGImageMetadataTagCopyPrefix(tag) as String?) ?? "?"
                                let name = (CGImageMetadataTagCopyName(tag) as String?) ?? "?"
                                let value = CGImageMetadataTagCopyValue(tag)
                                let typeRaw = CGImageMetadataTagGetType(tag)
                                print("[schema-probe] [\(prefix):\(name)] type=\(typeRaw) value=\(String(describing: value))")
                                // 若 value 是 String 且疑似 base64 plist，尝试解码
                                if let strValue = value as? String,
                                   let plistData = Data(base64Encoded: strValue) {
                                    if let decoded = try? PropertyListSerialization.propertyList(from: plistData, format: nil) {
                                        print("[schema-probe]   decoded-plist: \(decoded)")
                                    } else {
                                        print("[schema-probe]   (not a valid plist, raw bytes len=\(plistData.count))")
                                    }
                                }
                            }
                        } else {
                            print("[schema-probe] no tags at frame \(frameIdx)")
                        }
                    } else {
                        print("[schema-probe] no metadata at frame \(frameIdx)")
                    }
                }
                // 也打印图片属性
                if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any] {
                    print("[schema-probe] image props keys: \(props.keys.sorted())")
                }
                print("[schema-probe] done")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)

            case "image-wallpaper":
                let pick = try await RelightClient().fetchTodayPick()
                guard let photo = pick.photo else {
                    logger.error("no photo")
                    print("no photo"); exit(1)
                }
                if photo.isVideo {
                    logger.error("today pick is video, ImageEngine 不支持。请等任务 004 实现 VideoEngine")
                    print("today pick is video, skipping"); exit(2)  // 用 exit 2 区分"非错误但跳过"
                }
                let sourceURL = try await RelightClient().downloadOriginal(photo)
                let url = try await ImageWallpaperEngine().apply(
                    photo: photo, sourceURL: sourceURL, on: NSScreen.screens
                )
                logger.info("image-wallpaper applied: \(url.path)")
                print("image-wallpaper applied: \(url.path)")
                exit(0)

            case "video-wallpaper":
                let videoPhotoId = "09728ce3-6c07-4389-a9c1-f22d12f9f297"
                let settings = AppSettings.shared
                guard let apiURL = URL(string: "\(settings.apiURL)/api/photos/\(videoPhotoId)/original") else {
                    print("[self-test] invalid API URL"); exit(1)
                }
                let (data, response) = try await URLSession.shared.data(from: apiURL)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    print("[self-test] HTTP error: \(response)"); exit(1)
                }
                let cache = WallpaperCache.shared
                try cache.ensureDirectories()
                let fakePhoto = Photo(
                    id: videoPhotoId,
                    storageSourceId: "test",
                    filePath: "/tmp/relight-video-e2e/test-promo.mp4",
                    fileHash: "4c81094b954e514f906b10fa92dc1dead79daa3d82dd24edc7889d0aa0eaa0ad",
                    width: 1280, height: 720,
                    fileSize: data.count,
                    thumbnailPath: nil, takenAt: nil, fileMtime: nil,
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    mediaType: "video", durationSec: 49.1, videoCodec: "h264", videoFps: 30
                )
                let sourceURL = try cache.writeOriginal(
                    hash: fakePhoto.fileHash, ext: "mp4", data: data
                )
                let result = try await VideoWallpaperEngine().apply(
                    photo: fakePhoto, sourceURL: sourceURL, on: NSScreen.screens
                )
                print("[self-test] video-wallpaper applied: \(result.path)")
                logger.info("video-wallpaper applied: \(result.path)")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)

            case "menubar-smoke":
                let lsUIElement = (Bundle.main.object(forInfoDictionaryKey: "LSUIElement") as? Bool) ?? false
                print("[menubar-smoke] LSUIElement=\(lsUIElement)")
                let settings = AppSettings.shared
                print("[menubar-smoke] apiURL=\(settings.apiURL)")
                print("[menubar-smoke] autoStart=\(settings.autoStart)")
                print("[menubar-smoke] lastAppliedPickDate=\(settings.lastAppliedPickDate ?? "nil")")
                // 验证 MenuBarCommandBus 类型可实例化
                let bus = MenuBarCommandBus()
                print("[menubar-smoke] commandBus.onRefreshNow=\(bus.onRefreshNow == nil ? "nil" : "wired")")
                exit(0)

            case "coordinator-bootstrap":
                let cache = WallpaperCache.shared
                try? cache.ensureDirectories()
                let coordinator = WallpaperCoordinator(
                    client: RelightClient(),
                    imageEngine: ImageWallpaperEngine(),
                    videoEngine: VideoWallpaperEngine(cache: cache),
                    settings: AppSettings.shared
                )
                // 清空 lastAppliedPickDate 强制 bootstrap 触发
                await MainActor.run { AppSettings.shared.lastAppliedPickDate = nil }
                await coordinator.bootstrapOnLaunch()
                let today = BeijingTime.todayString()
                let applied = await MainActor.run { AppSettings.shared.lastAppliedPickDate }
                print("[coordinator-bootstrap] today=\(today) applied=\(applied ?? "nil")")
                try await Task.sleep(for: .milliseconds(100))
                exit(applied == today ? 0 : 1)

            case "aerial-probe":
                // 打印 videosPath 存在性 / assetIDs / 可写性 / backup 数（观测性 probe，不覆写）
                let engine = AerialVideoEngine()
                let fm = FileManager.default
                let exists = fm.fileExists(atPath: engine.videosPath.path)
                let writable = fm.isWritableFile(atPath: engine.videosPath.path)
                print("[aerial-probe] videosPath=\(engine.videosPath.path) exists=\(exists) writable=\(writable)")
                do {
                    let ids = try engine.collectAerialAssetIDs()
                    print("[aerial-probe] assetIDs=\(ids)")
                } catch {
                    print("[aerial-probe] assetIDs error: \(error)")
                }
                let backups = ((try? fm.contentsOfDirectory(atPath: engine.videosPath.path)) ?? [])
                    .filter { $0.hasSuffix(".mov.backup") }
                print("[aerial-probe] backups=\(backups.count) \(backups)")
                print("[aerial-probe] index=\(engine.indexURL.path)")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)

            case "aerial-apply":
                // 用本地文件真实执行一次覆写+备份（供验收脚本驱动 happy path）
                let args = CommandLine.arguments
                guard let fileIdx = args.firstIndex(of: "--file"), args.count > fileIdx + 1 else {
                    print("[self-test] aerial-apply 需要参数: --file <mov>")
                    try await Task.sleep(for: .milliseconds(100))
                    exit(1)
                }
                let fileArg = args[fileIdx + 1]
                let fileURL = URL(fileURLWithPath: fileArg)
                guard FileManager.default.fileExists(atPath: fileURL.path) else {
                    print("[self-test] aerial-apply 文件不存在: \(fileURL.path)")
                    try await Task.sleep(for: .milliseconds(100))
                    exit(1)
                }
                let dummyPhoto = Photo(
                    id: "aerial-apply-selftest",
                    storageSourceId: "selftest",
                    filePath: fileURL.path,
                    fileHash: "selftest-hash",
                    width: 1920, height: 1080,
                    fileSize: 0,
                    thumbnailPath: nil, takenAt: nil, fileMtime: nil,
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    mediaType: "image", durationSec: nil, videoCodec: nil, videoFps: nil
                )
                let result = try await AerialVideoEngine().apply(
                    photo: dummyPhoto, sourceURL: fileURL, on: NSScreen.screens
                )
                print("[aerial-apply] applied: \(result.path)")
                let fm = FileManager.default
                let backups = ((try? fm.contentsOfDirectory(atPath: AerialVideoEngine().videosPath.path)) ?? [])
                    .filter { $0.hasSuffix(".mov.backup") }
                print("[aerial-apply] backups=\(backups.count) \(backups)")
                try await Task.sleep(for: .milliseconds(100))
                exit(0)

            case "wallpaper-refresh-fallback":
                // 完整走 Coordinator.refreshNow 且注入故障（AerialVideoEngine 抛
                // AerialError.aerialNotSelected），断言回退后桌面为 Relight 静态图且
                // 输出含 aerial-fallback 标记（场景 6.P1/P2 落地驱动）。
                guard CommandLine.arguments.contains("--simulate-aerial-failure") else {
                    print("[self-test] wallpaper-refresh-fallback 需要参数: --simulate-aerial-failure")
                    try await Task.sleep(for: .milliseconds(100))
                    exit(1)
                }
                try await SelfTest.runRefreshFallback()

            default:
                print("[self-test] unknown mode: \(mode)")
                logger.error("unknown mode: \(mode)")
                try await Task.sleep(for: .milliseconds(100))
                exit(1)
            }
        } catch {
            print("[self-test] failed: \(error)")
            logger.error("self-test failed: \(error)")
            try? await Task.sleep(for: .milliseconds(100))
            exit(1)
        }
    }

    /// wallpaper-refresh-fallback --simulate-aerial-failure：
    /// 1. 起本地 fixture HTTP 服务（canned pick 含 wallpaperVideoUrl + 壁纸视频 + 合成图 JPEG）
    /// 2. 构造 Coordinator（aerialEngine = 必抛 AerialError.aerialNotSelected 的故障 stub）
    /// 3. refreshNow → Aerial 分支失败 → 断言回退静态链路：
    ///    NSWorkspace.desktopImageURL(for:) 指向 Relight 静态图 且 输出含 aerial-fallback 标记
    static func runRefreshFallback() async throws {
        let fm = FileManager.default
        let fixtureDir = fm.temporaryDirectory
            .appendingPathComponent("relight-aerial-fallback-fixture")
        try fm.createDirectory(at: fixtureDir, withIntermediateDirectories: true)
        let movBody = Data("00000000ftypisomselftest-mov-bytes".utf8)
        let movURL = fixtureDir.appendingPathComponent("wallpaper.mov")
        try movBody.write(to: movURL)

        // 生成 4×4 JPEG 作 fixture 合成图（setDesktopImageURL 需要真实图片）
        let img = NSImage(size: NSSize(width: 4, height: 4))
        img.lockFocus()
        NSColor(srgbRed: 0.97, green: 0.96, blue: 0.93, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: 4, height: 4).fill()
        img.unlockFocus()
        let tiff = img.tiffRepresentation!
        let rep = NSBitmapImageRep(data: tiff)!
        let jpegBody = rep.representation(using: .jpeg, properties: [:])!

        let server = FixtureHTTPServer(routes: [
            ("/api/daily/today", (200, "application/json", Data())),
            ("/api/daily/", (200, "image/jpeg", jpegBody)),
            ("/wallpaper.mov", (200, "video/quicktime", movBody)),
        ])
        try await server.start()
        print("[wallpaper-refresh-fallback] fixture server on port \(server.port)")
        // 回填 canned pick（wallpaperVideoUrl 指向 fixture 服务自身）
        let videoURL = "http://127.0.0.1:\(server.port)/wallpaper.mov"
        server.setResponse(for: "/api/daily/today", (200, "application/json", Self.cannedPickJSON(videoURL: videoURL)))

        // 保存真实 apiURL（self-test 结束后恢复，避免 fixture 端口残留）
        let savedApiURL = await MainActor.run { AppSettings.shared.apiURL }
        // AppSettings.shared 已在进程启动时读取 defaults——self-test 模式直接改写 shared 实例
        await MainActor.run { AppSettings.shared.apiURL = "http://127.0.0.1:\(server.port)" }
        defer {
            Task { @MainActor in
                AppSettings.shared.apiURL = savedApiURL
            }
        }

        let cache = WallpaperCache.shared
        try? cache.ensureDirectories()
        let coordinator = WallpaperCoordinator(
            client: RelightClient(settings: AppSettings.shared),
            imageEngine: ImageWallpaperEngine(),
            videoEngine: VideoWallpaperEngine(cache: cache),
            settings: AppSettings.shared,
            aerialEngine: FailingAerialEngine()
        )
        await coordinator.refreshNow()

        // 断言：桌面壁纸指向 Relight 静态图（s6p1 谓词）
        guard let screen = NSScreen.main ?? NSScreen.screens.first else {
            print("[self-test] no screen")
            exit(1)
        }
        let desktopURL = NSWorkspace.shared.desktopImageURL(for: screen)
        print("[wallpaper-refresh-fallback] desktopImageURL=\(desktopURL?.path ?? "nil")")
        let fallbackReason = await MainActor.run { AppSettings.shared.lastFallbackReason }
        print("[wallpaper-refresh-fallback] lastFallbackReason=\(fallbackReason ?? "nil")")

        var ok = true
        if let path = desktopURL?.path {
            let isRelightStatic = path.contains("Application Support/Relight")
                && ["jpg", "jpeg", "png"].contains((path as NSString).pathExtension.lowercased())
            if !isRelightStatic {
                print("[wallpaper-refresh-fallback] FAIL: 桌面壁纸不是 Relight 静态图")
                ok = false
            }
        } else {
            print("[wallpaper-refresh-fallback] FAIL: desktopImageURL 为 nil")
            ok = false
        }
        if (fallbackReason ?? "").contains("aerial-fallback") {
            print("aerial-fallback: 回退事件已记录（s6p2 断言输入）")
        } else {
            print("[wallpaper-refresh-fallback] FAIL: lastFallbackReason 不含 aerial-fallback 标记")
            ok = false
        }
        try await Task.sleep(for: .milliseconds(100))
        exit(ok ? 0 : 1)
    }

    /// canned pick JSON（wallpaperVideoUrl 指向 fixture 服务自身）
    private static func cannedPickJSON(videoURL: String) -> Data {
        let json = """
        {"success":true,"data":{"id":"selftest-pick","photoId":"selftest-photo","pickDate":"2000-01-01","title":"selftest","narrative":"selftest","score":8.0,"composedImageUrl":"/api/daily/2000-01-01/wallpaper","wallpaperVideoUrl":"\(videoURL)","createdAt":"2000-01-01T00:00:00.000Z","photo":{"id":"selftest-photo","storageSourceId":"selftest","filePath":"/tmp/selftest.jpg","fileHash":"selftest-hash","width":4,"height":4,"fileSize":1,"thumbnailPath":null,"takenAt":null,"fileMtime":null,"createdAt":"2000-01-01T00:00:00.000Z","mediaType":"image","durationSec":null,"videoCodec":null,"videoFps":null}}}
        """
        return Data(json.utf8)
    }
}

/// 故障注入 stub：apply 必抛 AerialError.aerialNotSelected（模拟「用户未选 Aerial」）
struct FailingAerialEngine: AerialVideoApplying {
    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL {
        throw AerialError.aerialNotSelected
    }

    func repairIfNeeded(cachedURL: URL) async throws -> Bool {
        false
    }
}

/// DEBUG self-test 用的最小 HTTP/1.1 fixture 服务（前缀路由，单进程内随机端口）
final class FixtureHTTPServer {
    typealias Route = (status: Int, contentType: String, body: Data)

    private var routes: [(prefix: String, response: Route)]
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    init(routes: [(prefix: String, response: Route)]) {
        self.routes = routes
    }

    /// 启动后回填/覆盖某条路由的响应体（canned pick 需要启动后的端口）
    func setResponse(for prefix: String, _ response: Route) {
        if let idx = routes.firstIndex(where: { $0.prefix == prefix }) {
            routes[idx] = (prefix, response)
        } else {
            routes.append((prefix, response))
        }
    }

    func start() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        self.listener = listener
        listener.start(queue: .global())
        for _ in 0..<200 {
            if let p = listener.port?.rawValue, p != 0 {
                port = p
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw RelightError.networkUnreachable(underlying: URLError(.cannotConnectToHost))
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .global())
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self, let data else {
                connection.cancel()
                return
            }
            let head = String(data: data.prefix(4096), encoding: .utf8) ?? ""
            let requestLine = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
            let path = requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            let route = path.split(separator: "?").first.map(String.init) ?? path

            let matched = self.routes.first { route.hasPrefix($0.prefix) }
            let response: Route = matched?.response ?? (404, "text/plain", Data("not found".utf8))
            let headStr = "HTTP/1.1 \(response.status) OK\r\nContent-Type: \(response.contentType)\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(headStr.utf8) + response.body, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
}
#endif
