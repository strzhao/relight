import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        TabView {
            GeneralSettingsTab()
                .tabItem { Label("常规", systemImage: "gear") }
                .environmentObject(settings)
            AboutTab()
                .tabItem { Label("关于", systemImage: "info.circle") }
        }
        .frame(minWidth: 420, minHeight: 280)
        .padding()
    }
}
