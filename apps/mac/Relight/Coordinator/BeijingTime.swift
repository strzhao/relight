import Foundation

enum BeijingTime {
  static let timeZone = TimeZone(identifier: "Asia/Shanghai")!

  static func todayString() -> String {
    let formatter = DateFormatter()
    formatter.timeZone = timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: Date())
  }

  static func nowComponents() -> DateComponents {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar.dateComponents([.year, .month, .day, .hour, .minute], from: Date())
  }
}
