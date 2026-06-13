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
                    guard let url = try? await client.downloadComposedWallpaper(
                        pickDate: pickDate, width: w, height: h) else { continue }
                    await MainActor.run {
                        try? NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [
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
