import SwiftUI

struct SettingsPage: View {
    @EnvironmentObject var viewModel: RuntimeStatusViewModel
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var commandBus: MenuBarCommandBus
    @State private var config: RuntimeConfigData?
    @State private var loading = false
    @State private var errorMsg: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                generalSection
                backendConfigSection
                aboutSection
            }
            .padding(16)
        }
        .navigationTitle("设置")
        .task { await load() }
    }

    // MARK: - 常规

    @ViewBuilder
    private var generalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("常规").font(.headline)
            VStack(alignment: .leading, spacing: 6) {
                Text("API URL")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("http://localhost:3000", text: $settings.apiURL)
                    .textFieldStyle(.roundedBorder)
                Text("默认 http://localhost:3000，worktree 下用对应端口")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Toggle("登录时自动启动", isOn: $settings.autoStart)
                .onChange(of: settings.autoStart) { newValue in
                    commandBus.onAutoStartChange?(newValue)
                }
        }
    }

    // MARK: - 后端配置（只读）

    @ViewBuilder
    private var backendConfigSection: some View {
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
                .padding(.top, 4)
        } else if loading {
            ProgressView("加载中…")
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 12)
        } else if let err = errorMsg {
            Text("加载失败: \(err)")
                .foregroundStyle(.red)
                .padding(.top, 12)
        }
    }

    // MARK: - 关于

    @ViewBuilder
    private var aboutSection: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.stack.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("拾光 (Relight)")
                .font(.title2.bold())
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
            Text("版本 \(version)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("AI 驱动的照片管理 · macOS 壁纸客户端")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 16)
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
