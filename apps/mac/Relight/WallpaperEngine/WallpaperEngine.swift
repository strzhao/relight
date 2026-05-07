import AppKit

protocol WallpaperEngine {
    /// 把 photo 设为壁纸，覆盖所有指定屏幕
    /// - Returns: 实际设置成功的壁纸文件 URL（图片引擎直接返回 sourceURL；视频引擎 004 返回生成的 .heic URL）
    func apply(photo: Photo, sourceURL: URL, on screens: [NSScreen]) async throws -> URL
}
