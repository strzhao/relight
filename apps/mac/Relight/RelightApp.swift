import SwiftUI
import OSLog

@main
struct RelightApp: App {
    init() {
        #if DEBUG
        let args = CommandLine.arguments
        if let mode = args.first(where: { $0.hasPrefix("--self-test=") })?
            .split(separator: "=", maxSplits: 1)
            .last
            .map(String.init) {
            Task.detached {
                await SelfTest.run(mode: mode)
            }
        }
        #endif
    }
    var body: some Scene {
        WindowGroup {
            ContentView()
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
