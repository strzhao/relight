import Foundation

private let kApiURL = "app.relight.apiURL"
private let kDefaultApiURL = "http://localhost:3000"

final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    @Published var apiURL: String {
        didSet {
            defaults.set(apiURL, forKey: kApiURL)
        }
    }

    private let defaults: UserDefaults

    fileprivate init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.apiURL = defaults.string(forKey: kApiURL) ?? kDefaultApiURL
    }
}
