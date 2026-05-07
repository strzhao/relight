import AppKit
import OSLog

/// 视频动态壁纸引擎：从视频抽取多帧，合成 apple_desktop:h24 动态 HEIC，
/// 再通过 NSWorkspace 设为所有指定屏幕的壁纸。
final class VideoWallpaperEngine: WallpaperEngine {
    private let cache: WallpaperCache
    private let frameCount: Int
    private let logger: Logger

    init(
        cache: WallpaperCache = .shared,
        frameCount: Int = 16,
        logger: Logger = Logger(subsystem: "app.relight.mac", category: "wallpaper.video")
    ) {
        self.cache      = cache
        self.frameCount = frameCount
        self.logger     = logger
    }

    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL {
        // 1. 仅支持视频
        guard photo.isVideo else {
            throw RelightError.wallpaperSetFailed(
                reason: "VideoWallpaperEngine 仅支持视频（photo.isVideo == false）",
                underlying: nil
            )
        }

        // 2. 确保缓存目录存在
        try cache.ensureDirectories()

        // 3. 检查缓存：<hash>.heic 已存在则跳过生成
        let outputURL = cache.dynamicHeicDir.appendingPathComponent("\(photo.fileHash).heic")
        if FileManager.default.fileExists(atPath: outputURL.path) {
            logger.info("cache hit: \(outputURL.path)")
        } else {
            // 4. 抽帧
            logger.info("开始抽帧：\(sourceURL.lastPathComponent)，共 \(self.frameCount) 帧")
            let frames = try VideoFrameExtractor.extract(from: sourceURL, count: frameCount)

            // 5. 写动态 HEIC
            try DynamicHeicBuilder.write(
                frames: frames,
                to: outputURL,
                lightIndex: 0,
                darkIndex: frameCount / 2
            )
            logger.info("已生成动态 HEIC：\(outputURL.path)（\(frames.count) 帧）")
        }

        // 6. 设置壁纸
        guard !screens.isEmpty else {
            logger.warning("screens 为空，跳过壁纸设置")
            return outputURL
        }
        for screen in screens {
            do {
                try NSWorkspace.shared.setDesktopImageURL(outputURL, for: screen, options: [:])
            } catch {
                throw RelightError.wallpaperSetFailed(
                    reason: "屏幕 \(screen.localizedName) 设置失败",
                    underlying: error
                )
            }
        }
        logger.info("已设置视频动态壁纸到 \(screens.count) 个屏幕")
        return outputURL
    }
}
