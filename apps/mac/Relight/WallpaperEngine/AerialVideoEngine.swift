import AppKit
import AVFoundation
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

/// Aerial 自注册引擎（动态视频壁纸，2026-11-11 姿势重构）
///
/// **为什么不再覆写 Apple asset 的 slot**：Tahoe 壁纸栈把 aerial 当 CDN 管理资产，
/// 对既有 Apple asset 的 slot 字节篡改会在 killall 重载后 ~30s 内被 WallpaperAerialsExtension
/// 从 Apple CDN 原样拉回（实测 2026-11-11：对齐 mtime/权限、剥 xattr、改 SourceURL xattr、
/// 改 manifest URL 四条路全部失败——`com.apple.provenance` SIP 保护，权威目录源用户态不可达）。
///
/// **正确姿势**（AerialMotion / LiveDesk 社区实证方案）：注册自有 assetID 进
/// aerial catalog——slot .mov、thumbnail、entries.json 条目、Index.plist 全 Provider
/// 选择四位一体；catalog 条目的全部 url-* 键指向本地 file:// URL，系统要「下载」时
/// 拉的就是本地文件自己，字节永远一致，校验天然通过。内容每日更新 = 覆写同一
/// {assetID}.mov（身份恒定，Index 选择不用重写）。
///
/// 任何失败 throw AerialError → Coordinator 回退现有静态链路（行为不变）。
final class AerialVideoEngine: WallpaperEngine, AerialVideoApplying {
    private let logger: Logger

    /// 拾光每日壁纸在 macOS aerial catalog 中的固定 assetID（内容每日覆写，身份恒定）
    static let relightAssetID = "C37A729D-D797-4C98-A546-D970E905C7F2"
    /// catalog 自有分类/子分类 ID（与 Apple 分类隔离，便于清理与识别）
    private static let relightCategoryID = "7F3A2941-7AA6-40DD-B64A-94481ABFD3D7"
    private static let relightSubcategoryID = "155832E9-A81F-4B29-95B8-99C6686CDB2A"
    /// macOS 壁纸栈探测的全部 url 变体键（缺一个可能黑屏，全注册）
    private static let urlKeys = ["url-4K-SDR", "url-4K-SDR-240FPS", "url-1080-SDR", "url-4K-HDR"]

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

    var thumbnailsPath: URL {
        URL(fileURLWithPath: NSString(string: "~/Library/Application Support/com.apple.wallpaper/aerials/thumbnails").expandingTildeInPath)
    }

    var catalogURL: URL {
        URL(fileURLWithPath: NSString(string: "~/Library/Application Support/com.apple.wallpaper/aerials/manifest/entries.json").expandingTildeInPath)
    }

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

        // 2. 四位一体注册：slot .mov + thumbnail + catalog 条目 + Index 全 Provider 指向
        try installAssetFiles(sourceURL: sourceURL)
        try upsertCatalogEntry()
        try pointIndex(at: Self.relightAssetID)

        // 3. 重载壁纸栈（-9 强杀 WallpaperAgent + WallpaperAerialsExtension，后者是校验还原者）
        reloadWallpaperStack()
        logger.info("Aerial 自注册完成：assetID=\(Self.relightAssetID) ← \(sourceURL.path)")
        return sourceURL
    }

    /// 已应用日自愈：slot 字节 / catalog 条目 / Index 选择 任一环节被系统改掉即全链重放（幂等）
    func repairIfNeeded(cachedURL: URL) async throws -> Bool {
        let fm = FileManager.default
        guard fm.fileExists(atPath: cachedURL.path) else { return false }

        let slot = videosPath.appendingPathComponent("\(Self.relightAssetID).mov")
        let cachedSize = fileSize(at: cachedURL) ?? 0
        let slotIntact = fm.fileExists(atPath: slot.path) && fileSize(at: slot) == cachedSize
        let catalogIntact = isRegisteredInCatalog()
        let indexIntact = indexPointsAt(assetID: Self.relightAssetID)

        guard !(slotIntact && catalogIntact && indexIntact) else { return false }

        try installAssetFiles(sourceURL: cachedURL)
        try upsertCatalogEntry()
        try pointIndex(at: Self.relightAssetID)
        reloadWallpaperStack()
        logger.warning("Aerial slot 自愈：注册链路被系统改动，已重放（slot=\(slotIntact) catalog=\(catalogIntact) index=\(indexIntact)）")
        return true
    }

    // MARK: - assetID 收集（探测用）

    /// 全树递归收集选中的 Aerial assetID。
    /// 不枚举固定 keyPath：Tahoe 下壁纸可按显示器/按桌面独立选择，assetID 实际挂在
    /// `Displays.<uuid>.Desktop` / `Spaces.<uuid>.Displays.<uuid>.Desktop` 等 Provider 路径下，
    /// 只有「所有屏幕统一选择」时才落在 `AllSpacesAndDisplays.*`——固定 keyPath 在前者布局下
    /// 永远扫空 → 误判 aerialNotSelected 回退静态（2026-11-11 实机判例）。
    func collectAerialAssetIDs() throws -> [String] {
        let fm = FileManager.default
        guard let data = fm.contents(atPath: indexURL.path) else {
            throw AerialError.slotUnavailable(path: indexURL.path, underlying: nil)
        }
        let root = try PropertyListSerialization.propertyList(from: data, format: nil)

        var ids: Set<String> = []
        collectAssetIDs(from: root, into: &ids)
        return ids.sorted()
    }

    /// 递归扫任意层级：dict 含 `assetID` 键即选中槽位；Data blob 尝试 plist 解码后继续下钻
    /// （Configuration 兼容嵌套 dict / binary plist Data / 空 Data——空 Data 解码失败自然跳过）
    private func collectAssetIDs(from node: Any, into ids: inout Set<String>) {
        if let dict = node as? [String: Any] {
            if let id = dict["assetID"] as? String {
                ids.insert(id)
            }
            for value in dict.values {
                collectAssetIDs(from: value, into: &ids)
            }
        } else if let array = node as? [Any] {
            for value in array {
                collectAssetIDs(from: value, into: &ids)
            }
        } else if let data = node as? Data,
                  let cfg = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] {
            collectAssetIDs(from: cfg, into: &ids)
        }
    }

    // MARK: - 注册四件套

    /// slot .mov + thumbnail 落位（chmod 644 + xattr -cr 剥净扩展属性——quarantine/来源标记
    /// 会让系统对文件起疑；provenance 由系统写入者自身产生，我们复制的东西不带最干净）
    private func installAssetFiles(sourceURL: URL) throws {
        let fm = FileManager.default
        try? fm.createDirectory(at: thumbnailsPath, withIntermediateDirectories: true)

        let slot = videosPath.appendingPathComponent("\(Self.relightAssetID).mov")
        if fm.fileExists(atPath: slot.path) {
            try fm.removeItem(at: slot)
        }
        try fm.copyItem(at: sourceURL, to: slot)
        try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: slot.path)
        runXattrClear(slot)
        logger.info("Aerial slot 已落位：\(slot.path)")

        let thumb = thumbnailsPath.appendingPathComponent("\(Self.relightAssetID).png")
        if let image = firstFrame(of: sourceURL), let png = pngData(of: image) {
            if fm.fileExists(atPath: thumb.path) {
                try fm.removeItem(at: thumb)
            }
            try png.write(to: thumb)
            try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: thumb.path)
            runXattrClear(thumb)
        }
    }

    /// catalog（entries.json）upsert 自有条目：全部 url-* 键指向本地 file:// URL——
    /// 系统校验/下载走的就是本地文件自己，字节恒一致，无 CDN 还原回路
    private func upsertCatalogEntry() throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: catalogURL.path) else {
            throw AerialError.slotUnavailable(path: catalogURL.path, underlying: nil)
        }
        let data = try Data(contentsOf: catalogURL)
        guard var catalog = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw AerialError.slotUnavailable(path: catalogURL.path, underlying: nil)
        }

        // 首次改动前留原始 catalog 备份（仅一次）
        let bak = catalogURL.appendingPathExtension("relight-backup")
        if !fm.fileExists(atPath: bak.path) {
            try? fm.copyItem(at: catalogURL, to: bak)
        }

        var assets = catalog["assets"] as? [[String: Any]] ?? []
        assets.removeAll { ($0["id"] as? String) == Self.relightAssetID }

        let slotURI = videosPath.appendingPathComponent("\(Self.relightAssetID).mov").absoluteString
        let thumbURI = thumbnailsPath.appendingPathComponent("\(Self.relightAssetID).png").absoluteString
        let maxOrder = assets.compactMap { $0["preferredOrder"] as? Int }.max() ?? 0

        var entry: [String: Any] = [
            "accessibilityLabel": "Relight Daily",
            "categories": [Self.relightCategoryID],
            "id": Self.relightAssetID,
            "includeInShuffle": true,
            "localizedNameKey": "Relight Daily",
            "pointsOfInterest": [String: String](),
            "preferredOrder": maxOrder + 1,
            "previewImage": thumbURI,
            "shotID": "RELIGHT_DAILY",
            "showInTopLevel": true,
            "subcategories": [Self.relightSubcategoryID],
        ]
        for key in Self.urlKeys {
            entry[key] = slotURI
        }
        assets.append(entry)
        catalog["assets"] = assets

        // 分类 + 子分类 upsert，代表资产指向自己
        var categories = catalog["categories"] as? [[String: Any]] ?? []
        categories.removeAll { ($0["id"] as? String) == Self.relightCategoryID }
        categories.append([
            "id": Self.relightCategoryID,
            "localizedDescriptionKey": "Relight",
            "localizedNameKey": "Relight",
            "preferredOrder": 999,
            "previewImage": thumbURI,
            "representativeAssetID": Self.relightAssetID,
            "subcategories": [[
                "id": Self.relightSubcategoryID,
                "localizedDescriptionKey": "Relight",
                "localizedNameKey": "Relight",
                "preferredOrder": 0,
                "previewImage": thumbURI,
                "representativeAssetID": Self.relightAssetID,
            ]],
        ])
        catalog["categories"] = categories

        let out = try JSONSerialization.data(withJSONObject: catalog, options: [.prettyPrinted, .sortedKeys])
        try out.write(to: catalogURL, options: .atomic)
    }

    /// Index.plist 全 Provider 指向自有 assetID（AllSpacesAndDisplays / SystemDefault /
    /// 顶层 Displays / Spaces 全覆盖——Tahoe 按显示器独立选择布局也在内），binary plist 原子写 + touch
    private func pointIndex(at assetID: String) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: indexURL.path) else { return }

        guard let data = try? Data(contentsOf: indexURL) else { return }
        var outer = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] ?? [String: Any]()

        let configData = try PropertyListSerialization.data(
            fromPropertyList: ["assetID": assetID],
            format: .binary,
            options: 0
        )

        let choice: [String: Any] = [
            "Configuration": configData,
            "Files": [Any](),
            "Provider": "com.apple.wallpaper.choice.aerials",
        ]

        let now = Date()
        let contentDict: [String: Any] = [
            "Choices": [choice],
            "EncodedOptionValues": "$null",
            "Shuffle": "$null",
        ]
        let itemDict: [String: Any] = [
            "Content": contentDict,
            "LastSet": now,
            "LastUse": now,
        ]

        // 1. AllSpacesAndDisplays：Linked + Idle
        outer["AllSpacesAndDisplays"] = [
            "Type": "linked",
            "Linked": itemDict,
            "Idle": itemDict,
        ]

        // 2. SystemDefault：Desktop + Idle + Linked
        outer["SystemDefault"] = [
            "Type": "individual",
            "Desktop": itemDict,
            "Idle": itemDict,
            "Linked": itemDict,
        ]

        // 3. 解析活动显示器 UUID（NSScreen 实时 + Index 既有），逐显示器 Desktop/Idle/Linked
        var displayUUIDs = Set<String>()
        for screen in NSScreen.screens {
            if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
               let cfUUID = CGDisplayCreateUUIDFromDisplayID(num)?.takeRetainedValue() {
                displayUUIDs.insert(CFUUIDCreateString(nil, cfUUID) as String)
            }
        }
        if let existingDisplays = outer["Displays"] as? [String: Any] {
            for k in existingDisplays.keys {
                displayUUIDs.insert(k)
            }
        }
        var displaysDict: [String: Any] = [:]
        for dID in displayUUIDs {
            displaysDict[dID] = [
                "Type": "individual",
                "Desktop": itemDict,
                "Idle": itemDict,
                "Linked": itemDict,
            ]
        }
        outer["Displays"] = displaysDict

        // 4. Spaces：默认空间 "" + 既有空间 UUID 全指向
        var spaceKeys = Set<String>([""])
        if let existingSpaces = outer["Spaces"] as? [String: Any] {
            for k in existingSpaces.keys {
                spaceKeys.insert(k)
            }
        }
        var spacesDict: [String: Any] = [:]
        for sKey in spaceKeys {
            spacesDict[sKey] = [
                "Default": [
                    "Type": "individual",
                    "Desktop": itemDict,
                    "Idle": itemDict,
                    "Linked": itemDict,
                ],
                "Displays": displaysDict,
            ]
        }
        outer["Spaces"] = spacesDict

        // 5. 清掉根级残留键（只保留四个 Provider 容器）
        for key in Array(outer.keys) {
            if key != "AllSpacesAndDisplays" && key != "SystemDefault" && key != "Displays" && key != "Spaces" {
                outer.removeValue(forKey: key)
            }
        }

        let out = try PropertyListSerialization.data(fromPropertyList: outer, format: .binary, options: 0)
        try out.write(to: indexURL, options: .atomic)
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: indexURL.path)
    }

    /// killall -9 WallpaperAgent WallpaperAerialsExtension（重载壁纸栈；忽略非零——进程可能不存在）
    private func reloadWallpaperStack() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
        p.arguments = ["-9", "WallpaperAgent", "WallpaperAerialsExtension"]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            logger.warning("killall 壁纸栈失败（忽略）: \(error.localizedDescription)")
        }
    }

    // MARK: - 自愈检查

    private func isRegisteredInCatalog() -> Bool {
        guard let data = try? Data(contentsOf: catalogURL),
              let catalog = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let assets = catalog["assets"] as? [[String: Any]] else { return false }
        return assets.contains { ($0["id"] as? String) == Self.relightAssetID }
    }

    /// Index 是否仍指向自有 asset（抽查 SystemDefault.Desktop 首个 choice）
    private func indexPointsAt(assetID: String) -> Bool {
        guard let data = try? Data(contentsOf: indexURL),
              let root = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let systemDefault = root["SystemDefault"] as? [String: Any],
              let desktop = systemDefault["Desktop"] as? [String: Any],
              let content = desktop["Content"] as? [String: Any],
              let choices = content["Choices"] as? [[String: Any]],
              let choice = choices.first else { return false }
        return extractAssetID(of: choice) == assetID
    }

    /// choice.Configuration（嵌套 dict 或 binary plist Data）解出 assetID
    private func extractAssetID(of choice: [String: Any]) -> String? {
        if let config = choice["Configuration"] as? [String: Any] {
            return config["assetID"] as? String
        }
        if let configData = choice["Configuration"] as? Data,
           let cfg = (try? PropertyListSerialization.propertyList(from: configData, format: nil)) as? [String: Any] {
            return cfg["assetID"] as? String
        }
        return nil
    }

    // MARK: - 小工具

    /// 视频首帧 → 位图（thumbnail 预览用）
    private func firstFrame(of videoURL: URL) -> NSImage? {
        let generator = AVAssetImageGenerator(asset: AVAsset(url: videoURL))
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        guard let cgImage = try? generator.copyCGImage(at: .zero, actualTime: nil) else {
            return nil
        }
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }

    /// NSImage → PNG data（AppKit 无 pngData，走 NSBitmapImageRep）
    private func pngData(of image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else {
            return nil
        }
        return rep.representation(using: .png, properties: [:])
    }

    private func runXattrClear(_ url: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        p.arguments = ["-cr", url.path]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            logger.warning("xattr -cr 失败（忽略）: \(error.localizedDescription)")
        }
    }

    private func fileSize(at url: URL) -> Int? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return attrs?[.size] as? Int
    }
}
