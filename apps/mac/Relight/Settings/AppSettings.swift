import Foundation

final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private struct Keys {
        static let apiURL = "app.relight.apiURL"
        static let autoStart = "app.relight.autoStart"
        static let lastAppliedPickDate = "app.relight.lastAppliedPickDate"
        static let lastFallbackReason = "app.relight.lastFallbackReason"
    }

    private static let kDefaultApiURL = "http://localhost:3000"

    @Published var apiURL: String {
        didSet {
            defaults.set(apiURL, forKey: Keys.apiURL)
        }
    }

    @Published var autoStart: Bool {
        didSet {
            defaults.set(autoStart, forKey: Keys.autoStart)
        }
    }

    @Published var lastAppliedPickDate: String? {
        didSet {
            defaults.set(lastAppliedPickDate, forKey: Keys.lastAppliedPickDate)
        }
    }

    /// 最近一次 Aerial 注入回退原因（含固定标记 aerial-fallback，验收可断言）
    @Published var lastFallbackReason: String? {
        didSet {
            defaults.set(lastFallbackReason, forKey: Keys.lastFallbackReason)
        }
    }

    private let defaults: UserDefaults

    fileprivate init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.apiURL = defaults.string(forKey: Keys.apiURL) ?? Self.kDefaultApiURL
        self.autoStart = defaults.bool(forKey: Keys.autoStart)
        self.lastAppliedPickDate = defaults.string(forKey: Keys.lastAppliedPickDate)
        self.lastFallbackReason = defaults.string(forKey: Keys.lastFallbackReason)
    }
}
