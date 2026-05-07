import Foundation
import ImageIO
import CoreGraphics

/// 将多帧 CGImage 序列写入 apple_desktop:h24 格式的动态 HEIC 文件。
///
/// Schema 来源（实测 Sonoma.heic + 实验写入验证，2026-05-07）：
///  - namespace:  "http://ns.apple.com/namespace/1.0/"，prefix "apple_desktop"
///  - tag name:   "h24"（Solar/时间序列，支持多帧；2帧 light/dark 用 "apr"）
///  - plist 结构（binary plist，base64 编码后存入 XMP）：
///      {
///        "si": 0.0,                          // solar angle start（通常 0）
///        "ap": {"l": lightIdx, "d": darkIdx}, // appearance：亮/暗帧索引
///        "ti": [{"i": frameIdx, "t": 0..1}]  // time index：t 为 0-1 的归一化时间
///      }
enum DynamicHeicBuilder {

    private static let appleDesktopNamespace = "http://ns.apple.com/namespace/1.0/"
    private static let appleDesktopPrefix    = "apple_desktop"

    /// 把 frames 写入 outputURL（.heic），嵌入 h24 动态壁纸 metadata。
    ///
    /// - Parameters:
    ///   - frames:     CGImage 数组，按时间顺序排列
    ///   - outputURL:  输出文件路径（必须以 .heic 结尾）
    ///   - lightIndex: 亮色模式对应帧索引（默认 0）
    ///   - darkIndex:  暗色模式对应帧索引（默认 frames.count/2）
    static func write(
        frames: [CGImage],
        to outputURL: URL,
        lightIndex: Int = 0,
        darkIndex: Int? = nil
    ) throws {
        guard !frames.isEmpty else {
            throw RelightError.videoConversionFailed(reason: "frames 为空，无法写入 HEIC", underlying: nil)
        }

        let count     = frames.count
        let darkIdx   = darkIndex ?? (count / 2)
        let lightIdx  = max(0, min(lightIndex, count - 1))
        let clampDark = max(0, min(darkIdx, count - 1))

        // 1. 构造 h24 plist
        let tiArray: [[String: Any]] = (0..<count).map { i in
            ["i": i, "t": Double(i) / Double(count)]
        }
        let plistDict: [String: Any] = [
            "si": 0.0,
            "ap": ["l": lightIdx, "d": clampDark],
            "ti": tiArray
        ]
        let plistData: Data
        do {
            plistData = try PropertyListSerialization.data(
                fromPropertyList: plistDict,
                format: .binary,
                options: 0
            )
        } catch {
            throw RelightError.videoConversionFailed(
                reason: "plist 序列化失败",
                underlying: error
            )
        }
        let base64str = plistData.base64EncodedString()

        // 2. 创建 ImageIO 目标
        guard let dest = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            "public.heic" as CFString,
            count,
            nil
        ) else {
            throw RelightError.videoConversionFailed(
                reason: "CGImageDestinationCreateWithURL 失败：\(outputURL.path)",
                underlying: nil
            )
        }

        // 3. 注册 namespace 并构造 metadata（仅用于第 0 帧）
        let metadata = CGImageMetadataCreateMutable()
        CGImageMetadataRegisterNamespaceForPrefix(
            metadata,
            appleDesktopNamespace as CFString,
            appleDesktopPrefix    as CFString,
            nil
        )

        guard let h24Tag = CGImageMetadataTagCreate(
            appleDesktopNamespace as CFString,
            appleDesktopPrefix    as CFString,
            "h24"                 as CFString,
            .string,
            base64str             as CFTypeRef
        ) else {
            throw RelightError.videoConversionFailed(
                reason: "CGImageMetadataTagCreate (h24) 失败",
                underlying: nil
            )
        }

        let setOK = CGImageMetadataSetTagWithPath(
            metadata, nil,
            "\(appleDesktopPrefix):h24" as CFString,
            h24Tag
        )
        guard setOK else {
            throw RelightError.videoConversionFailed(
                reason: "CGImageMetadataSetTagWithPath 失败",
                underlying: nil
            )
        }

        // 4. 写入第 0 帧（含 metadata）+ 其余帧
        let frame0Props: [String: Any] = [:]
        CGImageDestinationAddImageAndMetadata(
            dest, frames[0], metadata,
            frame0Props as CFDictionary
        )
        for i in 1..<count {
            CGImageDestinationAddImage(dest, frames[i], nil)
        }

        // 5. 最终化
        guard CGImageDestinationFinalize(dest) else {
            // 清理残留文件
            try? FileManager.default.removeItem(at: outputURL)
            throw RelightError.videoConversionFailed(
                reason: "CGImageDestinationFinalize 失败：写入 \(outputURL.path)",
                underlying: nil
            )
        }
    }
}
