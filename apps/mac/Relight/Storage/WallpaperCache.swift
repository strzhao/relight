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

    var composedDir: URL {
        ensureSubdir("composed")
    }

    private func ensureSubdir(_ name: String) -> URL {
        let url = rootURL.appendingPathComponent(name)
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        }
        return url
    }

    func findCachedComposed(pickDate: String, width: Int, height: Int) -> URL? {
        let url = composedDir.appendingPathComponent("\(pickDate)_\(width)x\(height).jpg")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// 清除指定日期的所有本地合成壁纸缓存（用户手动选择新照片后调用）
    func clearComposedCache(for pickDate: String) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(at: composedDir, includingPropertiesForKeys: nil) else {
            return
        }
        for url in contents where url.lastPathComponent.hasPrefix("\(pickDate)_") {
            try? fm.removeItem(at: url)
        }
    }

    func writeComposed(pickDate: String, width: Int, height: Int, data: Data) throws -> URL {
        let url = composedDir.appendingPathComponent("\(pickDate)_\(width)x\(height).jpg")
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw RelightError.cacheWriteFailed(path: url, underlying: error)
        }
        return url
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
