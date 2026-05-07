import SwiftUI

struct AboutTab: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.stack.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
            Text("拾光 (Relight)")
                .font(.title)
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
            Text("版本 \(version)")
                .foregroundStyle(.secondary)
            Text("AI 驱动的照片管理 · macOS 壁纸客户端")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
