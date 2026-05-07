import Foundation

final class MenuBarCommandBus: ObservableObject {
    var onRefreshNow: (() async -> Void)?
    var onOpenSettings: (() -> Void)?
}
