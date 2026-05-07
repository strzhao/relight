import Foundation

final class WallpaperCache {
    static let shared = WallpaperCache()

    private init() {}

    var rootURL: URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        return appSupport.appendingPathComponent("Relight/wallpapers")
    }

    var originalDir: URL {
        rootURL.appendingPathComponent("original")
    }

    var dynamicHeicDir: URL {
        rootURL.appendingPathComponent("dynamic-heic")
    }

    func ensureDirectories() throws {
        let fm = FileManager.default
        for dir in [originalDir, dynamicHeicDir] {
            if !fm.fileExists(atPath: dir.path) {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
        }
    }

    /// 任意扩展名匹配 — 通过文件名前缀 (hash) 查找缓存文件
    func findCachedOriginal(hash: String) -> URL? {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: originalDir,
            includingPropertiesForKeys: nil
        ) else { return nil }
        return contents.first { url in
            let name = url.deletingPathExtension().lastPathComponent
            return name == hash
        }
    }

    func writeOriginal(hash: String, ext: String, data: Data) throws -> URL {
        let fileName = "\(hash).\(ext)"
        let fileURL = originalDir.appendingPathComponent(fileName)
        do {
            try data.write(to: fileURL, options: .atomic)
        } catch {
            throw RelightError.cacheWriteFailed(path: fileURL, underlying: error)
        }
        return fileURL
    }
}
