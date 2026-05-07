import AVFoundation
import CoreGraphics
import OSLog

enum VideoFrameExtractor {
    private static let logger = Logger(subsystem: "app.relight.mac", category: "video.frame-extractor")

    /// 从视频文件均匀抽取 `count` 帧
    static func extract(from videoURL: URL, count: Int = 16) throws -> [CGImage] {
        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw RelightError.videoConversionFailed(
                reason: "视频文件不存在: \(videoURL.path)",
                underlying: nil
            )
        }

        let asset = AVURLAsset(url: videoURL)
        // 同步访问 duration（macOS 13 以下也支持）
        let duration = asset.duration
        let total = CMTimeGetSeconds(duration)
        guard total > 0 else {
            throw RelightError.videoConversionFailed(
                reason: "视频时长为 0，无法抽帧",
                underlying: nil
            )
        }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        // 精确定位每帧
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter  = CMTime(seconds: 0.1, preferredTimescale: 600)
        // 限制输出尺寸，避免内存爆炸（最大宽度 1920）
        generator.maximumSize = CGSize(width: 1920, height: 1080)

        var frames: [CGImage] = []
        frames.reserveCapacity(count)

        for i in 0..<count {
            let t = total * Double(i) / Double(count)
            let time = CMTime(seconds: t, preferredTimescale: 600)
            do {
                let img = try generator.copyCGImage(at: time, actualTime: nil)
                frames.append(img)
                logger.debug("extracted frame \(i)/\(count) at t=\(String(format: "%.2f", t))s")
            } catch {
                throw RelightError.videoConversionFailed(
                    reason: "第 \(i) 帧抽取失败（t=\(String(format: "%.2f", t))s）",
                    underlying: error
                )
            }
        }

        logger.info("抽帧完成：\(frames.count) 帧，视频时长 \(String(format: "%.1f", total))s")
        return frames
    }
}
