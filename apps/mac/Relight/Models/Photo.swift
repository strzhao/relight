import Foundation

struct Photo: Codable, Identifiable {
    let id: String
    let storageSourceId: String
    let filePath: String
    let fileHash: String
    let width: Int
    let height: Int
    let fileSize: Int
    let thumbnailPath: String?
    let takenAt: String?
    let fileMtime: Int?
    let createdAt: String
    let mediaType: String?      // "image" | "video"
    let durationSec: Double?
    let videoCodec: String?
    let videoFps: Double?
}

extension Photo {
    var isVideo: Bool {
        if let mt = mediaType { return mt == "video" }
        let ext = (filePath as NSString).pathExtension.lowercased()
        return ["mp4", "mov", "avi", "mkv", "webm", "m4v"].contains(ext)
    }
}
