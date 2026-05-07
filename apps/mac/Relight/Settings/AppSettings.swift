import Foundation

final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private struct Keys {
        static let apiURL = "app.relight.apiURL"
        static let autoStart = "app.relight.autoStart"
        static let lastAppliedPickDate = "app.relight.lastAppliedPickDate"
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

    private let defaults: UserDefaults

    fileprivate init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.apiURL = defaults.string(forKey: Keys.apiURL) ?? Self.kDefaultApiURL
        self.autoStart = defaults.bool(forKey: Keys.autoStart)
        self.lastAppliedPickDate = defaults.string(forKey: Keys.lastAppliedPickDate)
    }
}
