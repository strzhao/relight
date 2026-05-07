import Foundation

struct ApiError: Codable {
    let message: String?
}

struct ApiResponse<T: Codable>: Codable {
    let success: Bool
    let data: T?
    let error: ApiError?
}
