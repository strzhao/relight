import Foundation

enum RelightError: Error, CustomStringConvertible {
    case networkUnreachable(underlying: Error)
    case invalidResponse(statusCode: Int, body: String?)
    case decodingFailed(underlying: Error)
    case cacheWriteFailed(path: URL, underlying: Error)
    case noPickAvailable
    case wallpaperSetFailed(reason: String, underlying: Error?)

    var description: String {
        switch self {
        case .networkUnreachable(let err):
            return "网络不可达: \(err.localizedDescription)"
        case .invalidResponse(let statusCode, let body):
            return "无效响应 HTTP \(statusCode): \(body ?? "(无正文)")"
        case .decodingFailed(let err):
            return "解码失败: \(err.localizedDescription)"
        case .cacheWriteFailed(let path, let err):
            return "缓存写入失败 \(path.path): \(err.localizedDescription)"
        case .noPickAvailable:
            return "今日精选不可用"
        case .wallpaperSetFailed(let reason, _):
            return "壁纸设置失败: \(reason)"
        }
    }
}
