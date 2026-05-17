import SwiftUI

struct SettingsPage: View {
    @EnvironmentObject var viewModel: RuntimeStatusViewModel
    @State private var config: RuntimeConfigData?
    @State private var loading = false
    @State private var errorMsg: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let cfg = config {
                    configSection("存储") {
                        configRow("STORAGE_ROOT", cfg.storageRoot)
                        configRow("DATABASE_PATH", cfg.databasePath)
                    }
                    configSection("AI") {
                        configRow("AI_BASE_URL", cfg.aiBaseUrl)
                        configRow("AI_MODEL", cfg.aiModel)
                        configRow("AI_VISION_MODEL", cfg.aiVisionModel)
                        configRow("AI_API_KEY", cfg.aiApiKey)
                    }
                    configSection("基础设施") {
                        configRow("REDIS_URL", cfg.redisUrl)
                        configRow("BULLMQ_PREFIX", cfg.bullmqPrefix)
                    }
                    Text("修改请编辑 `.env`，重启后端 + workers 后生效。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 12)
                } else if loading {
                    ProgressView("加载中…")
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.top, 40)
                } else if let err = errorMsg {
                    Text("加载失败: \(err)")
                        .foregroundStyle(.red)
                        .padding(.top, 40)
                }
            }
            .padding(16)
        }
        .navigationTitle("设置")
        .task { await load() }
    }

    @ViewBuilder
    private func configSection<C: View>(_ title: String, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            content()
        }
    }

    private func configRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 160, alignment: .leading)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
            Spacer()
        }
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            self.config = try await viewModel.fetchConfig()
        } catch {
            self.errorMsg = error.localizedDescription
        }
    }
}
