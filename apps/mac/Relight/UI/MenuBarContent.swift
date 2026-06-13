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
            DispatchQueue.global().async {
                let client = RelightClient()
                let cache = WallpaperCache.shared
                let semaphore = DispatchSemaphore(value: 0)
                Task {
                    do {
                        let pick = try await client.fetchTodayPick()
                        // composedImageUrl 可能在手动选择后被清空（等待重合成），
                        // 不依赖它——直接按屏幕分辨率调 wallpaper API，服务端会自动合成
                        let pickDate = pick.pickDate
                        cache.clearComposedCache(for: pickDate)
                        var wallpaperPaths: [String] = []
                        for screen in NSScreen.screens {
                            let scale = screen.backingScaleFactor
                            let w = Int(screen.frame.width * scale)
                            let h = Int(screen.frame.height * scale)
                            if let url = try? await client.downloadComposedWallpaper(
                                pickDate: pickDate, width: w, height: h) {
                                wallpaperPaths.append(url.path)
                            }
                        }
                        for path in wallpaperPaths {
                            let proc = Process()
                            proc.launchPath = "/usr/bin/osascript"
                            proc.arguments = ["-e", "tell application \"System Events\" to tell every desktop to set picture to \"\(path)\""]
                            proc.launch()
                            proc.waitUntilExit()
                        }
                        await MainActor.run { AppSettings.shared.lastAppliedPickDate = pickDate }
                    } catch { }
                    semaphore.signal()
                }
                semaphore.wait()
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
