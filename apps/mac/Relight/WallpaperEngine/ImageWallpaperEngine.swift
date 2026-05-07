import AppKit
import OSLog

final class ImageWallpaperEngine: WallpaperEngine {
    private let logger: Logger

    init(logger: Logger = Logger(subsystem: "app.relight.mac", category: "wallpaper.image")) {
        self.logger = logger
    }

    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL {
        // 1. 校验 isVideo == false
        if photo.isVideo {
            throw RelightError.wallpaperSetFailed(reason: "ImageEngine 不支持视频", underlying: nil)
        }
        // 2. 校验文件存在
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw RelightError.wallpaperSetFailed(reason: "源文件不存在: \(sourceURL.path)", underlying: nil)
        }
        // 3. 遍历 screens
        for screen in screens {
            do {
                try NSWorkspace.shared.setDesktopImageURL(sourceURL, for: screen, options: [:])
            } catch {
                throw RelightError.wallpaperSetFailed(
                    reason: "screen \(screen.localizedName) 设置失败",
                    underlying: error
                )
            }
        }
        logger.info("已设置壁纸到 \(screens.count) 个屏幕：\(sourceURL.path)")
        return sourceURL
    }
}
