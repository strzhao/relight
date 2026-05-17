import SwiftUI
import OSLog
import ImageIO

@main
struct RelightApp: App {
    @StateObject private var settings = AppSettings.shared
    @StateObject private var commandBus = MenuBarCommandBus()
    @StateObject private var healthMonitor = MenuBarHealthMonitor()

    // 单例式持有 coordinator/autostart，避免 actor 在 init 内被 capture self 问题
    fileprivate static var sharedCoordinator: WallpaperCoordinator?
    fileprivate static var sharedAutostart: AutostartManager?

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
            settings: AppSettings.shared
        )
        let autostart = AutostartManager()
        Self.sharedCoordinator = coordinator
        Self.sharedAutostart = autostart

        // 启动 bootstrap + scheduler
        Task.detached {
            await coordinator.bootstrapOnLaunch()
            await coordinator.startScheduler()
        }

        // 启动时同步 autostart 状态（首次注册可能弹系统授权）
        autostart.sync(enabled: AppSettings.shared.autoStart)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent()
                .environmentObject(commandBus)
                .task {
                    // 每次 task 重新 wire（即使被多次调用也是设置同一 closure）
                    commandBus.onRefreshNow = {
                        await Self.sharedCoordinator?.refreshNow()
                    }
                    healthMonitor.start()
                }
        } label: {
            Image(systemName: healthMonitor.iconName)
        }
        Window("拾光 — 控制中心", id: "control-center") {
            ControlCenterView()
                .environmentObject(settings)
        }
        Settings {
            SettingsView()
                .environmentObject(settings)
                .onChange(of: settings.autoStart) { newValue in
                    Self.sharedAutostart?.sync(enabled: newValue)
                }
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
}
#endif
