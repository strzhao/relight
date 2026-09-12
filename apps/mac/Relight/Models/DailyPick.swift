import Foundation

struct DailyPick: Codable, Identifiable {
    let id: String
    let photoId: String
    let pickDate: String
    let title: String
    let narrative: String
    let score: Double
    let composedImageUrl: String?
    /// 横版壁纸视频 COS URL（Aerial 注入用，.mov；可选字段向后兼容旧 API，无则 nil）
    let wallpaperVideoUrl: String?
    let createdAt: String
    let photo: Photo?
}
