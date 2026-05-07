import Foundation

final class RelightClient {
    private let settings: AppSettings
    private let urlSession: URLSession

    init(settings: AppSettings = .shared, urlSession: URLSession = .shared) {
        self.settings = settings
        self.urlSession = urlSession
    }

    func fetchTodayPick() async throws -> DailyPick {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/daily/today") else {
            throw RelightError.invalidResponse(statusCode: 0, body: "无效的 API URL: \(baseURL)")
        }

        let (data, response) = try await performRequest(url: url)
        let httpResponse = response as! HTTPURLResponse

        guard (200...299).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw RelightError.invalidResponse(statusCode: httpResponse.statusCode, body: body)
        }

        let decoded: ApiResponse<DailyPick>
        do {
            decoded = try JSONDecoder().decode(ApiResponse<DailyPick>.self, from: data)
        } catch {
            throw RelightError.decodingFailed(underlying: error)
        }

        guard let pick = decoded.data else {
            throw RelightError.noPickAvailable
        }
        return pick
    }

    func downloadOriginal(_ photo: Photo) async throws -> URL {
        let cache = WallpaperCache.shared
        try cache.ensureDirectories()

        // 检查缓存命中
        if let cached = cache.findCachedOriginal(hash: photo.fileHash) {
            return cached
        }

        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        // 使用 /api/photos/:id/original 端点（如果不存在则用缩略图兜底）
        let encodedId = photo.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? photo.id
        guard let url = URL(string: "\(baseURL)/api/photos/\(encodedId)/original") else {
            throw RelightError.invalidResponse(statusCode: 0, body: "无效的下载 URL")
        }

        let (data, response) = try await performRequest(url: url)
        let httpResponse = response as! HTTPURLResponse

        guard (200...299).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw RelightError.invalidResponse(statusCode: httpResponse.statusCode, body: body)
        }

        // 根据 Content-Type 决定扩展名
        let contentType = httpResponse.value(forHTTPHeaderField: "Content-Type") ?? ""
        let ext = extensionFromContentType(contentType, fallbackPath: photo.filePath)

        return try cache.writeOriginal(hash: photo.fileHash, ext: ext, data: data)
    }

    // MARK: - Private

    private func performRequest(url: URL) async throws -> (Data, URLResponse) {
        do {
            return try await urlSession.data(from: url)
        } catch let urlError as URLError {
            throw RelightError.networkUnreachable(underlying: urlError)
        }
    }

    private func extensionFromContentType(_ contentType: String, fallbackPath: String) -> String {
        let ct = contentType.lowercased()
        if ct.contains("image/jpeg") || ct.contains("image/jpg") {
            return "jpg"
        } else if ct.contains("image/png") {
            return "png"
        } else if ct.contains("image/heic") || ct.contains("image/heif") {
            return "heic"
        } else if ct.contains("image/webp") {
            return "webp"
        } else if ct.contains("video/") {
            // 对于视频，使用原始文件扩展名
            let originalExt = (fallbackPath as NSString).pathExtension.lowercased()
            return originalExt.isEmpty ? "mp4" : originalExt
        } else {
            // 兜底：使用原始文件扩展名
            let originalExt = (fallbackPath as NSString).pathExtension.lowercased()
            return originalExt.isEmpty ? "bin" : originalExt
        }
    }
}
