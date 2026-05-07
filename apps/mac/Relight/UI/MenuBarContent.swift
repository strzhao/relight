import SwiftUI
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
            Task {
                if let cb = commandBus.onRefreshNow {
                    await cb()
                } else {
                    logger.warning("refreshNow callback not wired")
                }
            }
        }
        Divider()
        settingsButton
        Button("退出 拾光") {
            NSApp.terminate(nil)
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
