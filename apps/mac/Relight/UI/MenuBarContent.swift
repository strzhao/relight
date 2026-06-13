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
            // 直接在这里执行更新逻辑
            Task.detached {
                let client = RelightClient()
                do {
                    let pick = try await client.fetchTodayPick()
                    guard let photo = pick.photo, !photo.isVideo,
                          pick.composedImageUrl != nil else { return }
                    WallpaperCache.shared.clearComposedCache(for: pick.pickDate)
                    for screen in NSScreen.screens {
                        let scale = screen.backingScaleFactor
                        let w = Int(screen.frame.width * scale)
                        let h = Int(screen.frame.height * scale)
                        if let url = try? await client.downloadComposedWallpaper(
                            pickDate: pick.pickDate, width: w, height: h
                        ) {
                            try? NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [
                                .imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue,
                                .allowClipping: false,
                                .fillColor: NSColor(srgbRed: 0.972, green: 0.961, blue: 0.929, alpha: 1.0),
                            ])
                        }
                    }
                    await MainActor.run { AppSettings.shared.lastAppliedPickDate = pick.pickDate }
                } catch { }
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
