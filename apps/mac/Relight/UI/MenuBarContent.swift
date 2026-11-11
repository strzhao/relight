import SwiftUI
import AppKit

struct MenuBarContent: View {
    @EnvironmentObject var commandBus: MenuBarCommandBus

    var body: some View {
        Text("拾光 — 当日精选")
            .foregroundStyle(.secondary)
            .disabled(true)
        Divider()
        Button("立即更新壁纸") {
            // 必须走 Coordinator（aerial 注册优先，失败才静态回退）——
            // ⚠️ 禁止在这里自带静态下载链路：setDesktopImageURL 会把 Index.plist 的
            // Desktop 选择改写成 imageFile，踩掉 aerial 注册（2026-11-11 实测判例）
            Task.detached { [commandBus] in
                await commandBus.onRefreshNow?()
            }
        }
        Divider()
        openControlCenterButton
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
