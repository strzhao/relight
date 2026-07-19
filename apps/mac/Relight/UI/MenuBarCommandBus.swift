import Foundation

final class MenuBarCommandBus: ObservableObject {
    var onRefreshNow: (() async -> Void)?
    var onAutoStartChange: ((Bool) -> Void)?
}
