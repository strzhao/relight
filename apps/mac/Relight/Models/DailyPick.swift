import Foundation

struct DailyPick: Codable, Identifiable {
    let id: String
    let photoId: String
    let pickDate: String
    let title: String
    let narrative: String
    let score: Double
    let createdAt: String
    let photo: Photo?
}
