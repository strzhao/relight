import SwiftUI
import AppKit
import OSLog

private let logger = Logger(subsystem: "app.relight.mac", category: "MenuBarContent")

struct MenuBarContent: View {
    @EnvironmentObject var commandBus: MenuBarCommandBus

    var body: some View {
        Text("拾光 — 当日精选")
            .foregroundStyle(.secondary)
            .disabled(true)
        Divider()
        Button("立即更新壁纸") {
            Task.detached {
                let client = RelightClient()
                let cache = WallpaperCache.shared
                guard let pick = try? await client.fetchTodayPick() else { return }
                let pickDate = pick.pickDate
                cache.clearComposedCache(for: pickDate)
                for screen in NSScreen.screens {
                    let s = screen.backingScaleFactor
                    let w = Int(screen.frame.width * s); let h = Int(screen.frame.height * s)
                    // ⚠️ 每次下载到唯一文件名，绕过 macOS 同名文件图片缓存
                    let ts = Int(Date().timeIntervalSince1970 * 1000)
                    let uniqueName = "\(pickDate)_\(w)x\(h)_\(ts).jpg"
                    let wallpaperURL = cache.composedDir.appendingPathComponent(uniqueName)
                    // 直接通过 API 下载（不走 writeComposed，避免共用文件名）
                    guard let apiURL = URL(string: "http://localhost:3000/api/daily/\(pickDate)/wallpaper?width=\(w)&height=\(h)"),
                          let (data, _) = try? await URLSession(configuration: .ephemeral).data(from: apiURL),
                          (try? data.write(to: wallpaperURL)) != nil else { continue }
                    await MainActor.run {
                        try? NSWorkspace.shared.setDesktopImageURL(wallpaperURL, for: screen, options: [
                            .imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue,
                            .allowClipping: false,
                            .fillColor: NSColor(srgbRed: 0.972, green: 0.961, blue: 0.929, alpha: 1.0),
                        ])
                    }
                }
                await MainActor.run { AppSettings.shared.lastAppliedPickDate = pickDate }
            }
        }
        Divider()
        openControlCenterButton
        settingsButton
        Button("退出 拾光") {
            NSApp.terminate(nil)
        }
    }

    @ViewBuilder
    private var openControlCenterButton: some View {
        if #available(macOS 14, *) {
            OpenControlCenterButton()
        }
    }

    @ViewBuilder
    private var settingsButton: some View {
        if #available(macOS 14, *) {
            MenuBarSettingsButton(commandBus: commandBus)
        } else {
            Button("设置...") {
                if let onOpen = commandBus.onOpenSettings {
                    onOpen()
                } else {
                    logger.warning("openSettings callback not wired (macOS 13 fallback)")
                }
            }
        }
    }
}

@available(macOS 14, *)
private struct MenuBarSettingsButton: View {
    let commandBus: MenuBarCommandBus
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button("设置...") {
            if let onOpen = commandBus.onOpenSettings {
                onOpen()
            } else {
                openSettings()
            }
        }
    }
}

@available(macOS 14, *)
private struct OpenControlCenterButton: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("打开控制中心") {
            openWindow(id: "control-center")
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
