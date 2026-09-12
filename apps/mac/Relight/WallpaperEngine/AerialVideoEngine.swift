import AppKit
import OSLog

/// Aerial 注入错误契约（state.md ## 契约规约 错误契约 Mac）
enum AerialError: Error, CustomStringConvertible {
    /// Index.plist 解码后无任何含 assetID 的 Aerial choice——用户未在系统设置选过 Aerial 桌面壁纸
    case aerialNotSelected
    /// Aerial videos 目录不存在（macOS 14-15 旧路径不支持）或不可写
    case slotUnavailable(path: String, underlying: Error?)

    var description: String {
        switch self {
        case .aerialNotSelected:
            return "未检测到 Aerial 壁纸选择（需在系统设置把桌面壁纸选成某个 Aerial，一次性）"
        case .slotUnavailable(let path, let err):
            let reason = err.map { "：\($0.localizedDescription)" } ?? ""
            return "Aerial 视频目录不可用 \(path)\(reason)"
        }
    }
}

/// Aerial 注入能力抽象（供 WallpaperCoordinator 依赖注入与 self-test 故障注入）
protocol AerialVideoApplying {
    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL
    /// 已应用日自愈：slot 文件与缓存不一致（系统重新下载/恢复原片）时重新覆写
    /// - Returns: 是否执行了修复
    func repairIfNeeded(cachedURL: URL) async throws -> Bool
}

/// Aerial 视频注入引擎（动态视频壁纸，state.md ## Mac App 设计 4）
///
/// 不做「新增条目」，而是**槽位覆写**：读 Index.plist 已选中 Aerial 的 assetID，
/// 把自有 .mov 覆盖到 `~/Library/Application Support/com.apple.wallpaper/aerials/videos/{assetID}.mov`
/// （Tahoe 用户级目录免管理员），首次保留 `{assetID}.mov.backup`，
/// 然后 `killall WallpaperAgent legacyScreenSaver` 重载。
/// 任何失败 throw AerialError → Coordinator 回退现有静态链路（行为不变）。
final class AerialVideoEngine: WallpaperEngine, AerialVideoApplying {
    private let logger: Logger

    init(logger: Logger = Logger(subsystem: "app.relight.mac", category: "wallpaper.aerial")) {
        self.logger = logger
    }

    /// Tahoe 用户级 Aerial 视频目录（macOS 14-15 旧路径不做支持 → 视为不支持回退）
    var videosPath: URL {
        URL(fileURLWithPath: NSString(string: "~/Library/Application Support/com.apple.wallpaper/aerials/videos").expandingTildeInPath)
    }

    /// 用户级壁纸配置 Index.plist
    var indexURL: URL {
        URL(fileURLWithPath: NSString(string: "~/Library/Application Support/com.apple.wallpaper/Store/Index.plist").expandingTildeInPath)
    }

    /// Index.plist 中 Aerial choice 的 assetID keyPath 集合（LiveDesk LockScreenManager 同法）
    private static let choiceKeyPaths: [[String]] = [
        ["AllSpacesAndDisplays", "Idle", "Content", "Choices"],
        ["AllSpacesAndDisplays", "Desktop", "Content", "Choices"],
        ["AllSpacesAndDisplays", "Linked", "Content", "Choices"],
        ["SystemDefault", "Linked", "Content", "Choices"],
    ]

    // MARK: - WallpaperEngine / AerialVideoApplying

    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL {
        let fm = FileManager.default

        // 1. videos 目录存在性 + 可写性（macOS 14-15 / 权限异常 → 回退）
        guard fm.fileExists(atPath: videosPath.path), fm.isWritableFile(atPath: videosPath.path) else {
            throw AerialError.slotUnavailable(path: videosPath.path, underlying: nil)
        }
        guard fm.fileExists(atPath: sourceURL.path) else {
            throw AerialError.slotUnavailable(path: sourceURL.path, underlying: nil)
        }

        // 2. 收集已选中 Aerial 的 assetID（为空 → 用户未选过 Aerial）
        let assetIDs = try collectAerialAssetIDs()
        guard !assetIDs.isEmpty else {
            throw AerialError.aerialNotSelected
        }

        // 3. 槽位覆写（首次保留 {assetID}.mov.backup）+ killall 重载
        try overwriteSlots(assetIDs: assetIDs, with: sourceURL, backup: true)
        reloadWallpaperAgent()
        logger.info("Aerial 注入完成：\(assetIDs.count) 个 slot ← \(sourceURL.path)")
        return sourceURL
    }

    func repairIfNeeded(cachedURL: URL) async throws -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: cachedURL.path) else { return false }
        let assetIDs = try collectAerialAssetIDs()
        guard !assetIDs.isEmpty else { return false }

        let cachedSize = fileSize(at: cachedURL)
        let mismatched = assetIDs.filter { id in
            let slot = videosPath.appendingPathComponent("\(id).mov")
            return slot != cachedURL ? fileSize(at: slot) != cachedSize : false
        }
        guard !mismatched.isEmpty else {
            return false
        }
        try overwriteSlots(assetIDs: mismatched, with: cachedURL, backup: false)
        reloadWallpaperAgent()
        logger.warning("Aerial slot 自愈：重新覆写 \(mismatched.count) 个（系统可能重新下载了原片）")
        return true
    }

    // MARK: - assetID 收集

    /// 读 Index.plist，解码含 assetID 的 choice（Configuration 为嵌套 dict 或 binary plist Data）
    func collectAerialAssetIDs() throws -> [String] {
        let fm = FileManager.default
        guard let data = fm.contents(atPath: indexURL.path) else {
            throw AerialError.slotUnavailable(path: indexURL.path, underlying: nil)
        }
        let root = try PropertyListSerialization.propertyList(from: data, format: nil)
        guard let dict = root as? [String: Any] else { return [] }

        var ids: Set<String> = []
        for keyPath in Self.choiceKeyPaths {
            guard let choices = valueForKeyPath(keyPath, in: dict) as? [[String: Any]] else { continue }
            for choice in choices {
                if let id = assetID(of: choice) {
                    ids.insert(id)
                }
            }
        }
        return ids.sorted()
    }

    private func valueForKeyPath(_ keys: [String], in dict: [String: Any]) -> Any? {
        var current: Any? = dict
        for key in keys {
            guard let d = current as? [String: Any] else { return nil }
            current = d[key]
        }
        return current
    }

    private func assetID(of choice: [String: Any]) -> String? {
        if let config = choice["Configuration"] as? [String: Any] {
            return config["assetID"] as? String
        }
        if let configData = choice["Configuration"] as? Data,
           let cfg = (try? PropertyListSerialization.propertyList(from: configData, format: nil)) as? [String: Any] {
            return cfg["assetID"] as? String
        }
        return nil
    }

    // MARK: - 槽位覆写

    /// 覆写 {assetID}.mov；backup=true 时对每个已存在且无 .backup 的 slot 先 `cp -p` 备份（仅首次）
    private func overwriteSlots(assetIDs: [String], with sourceURL: URL, backup: Bool) throws {
        let fm = FileManager.default
        for id in assetIDs {
            let slot = videosPath.appendingPathComponent("\(id).mov")
            let backupURL = videosPath.appendingPathComponent("\(id).mov.backup")

            if backup, fm.fileExists(atPath: slot.path), !fm.fileExists(atPath: backupURL.path) {
                try fm.copyItem(at: slot, to: backupURL)
                logger.info("Aerial slot 首次备份：\(slot.path) → \(backupURL.path)")
            }
            if fm.fileExists(atPath: slot.path) {
                try fm.removeItem(at: slot)
            }
            try fm.copyItem(at: sourceURL, to: slot)
            logger.info("Aerial slot 已覆写：\(slot.path)")
        }
    }

    /// killall WallpaperAgent legacyScreenSaver（重载壁纸；忽略非零——进程可能不存在）
    private func reloadWallpaperAgent() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
        p.arguments = ["WallpaperAgent", "legacyScreenSaver"]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            logger.warning("killall WallpaperAgent 失败（忽略）: \(error.localizedDescription)")
        }
    }

    private func fileSize(at url: URL) -> Int? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return attrs?[.size] as? Int
    }
}
