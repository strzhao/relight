import AppKit
import Foundation
import SwiftUI

struct SettingsPage: View {
    @EnvironmentObject var viewModel: RuntimeStatusViewModel
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var commandBus: MenuBarCommandBus
    @State private var config: RuntimeConfigData?
    @State private var loading = false
    @State private var errorMsg: String?
    @StateObject private var pushVM = PushSettingsViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                generalSection
                backendConfigSection
                pushSection
                aboutSection
            }
            .padding(16)
        }
        .navigationTitle("设置")
        .task { await load() }
        .task { await pushVM.load(apiBase: settings.apiURL) }
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

    // MARK: - 壁纸群推送

    @ViewBuilder
    private var pushSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("壁纸群推送").font(.headline)
            VStack(alignment: .leading, spacing: 6) {
                Text("企业微信群机器人 Webhook")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField(
                    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
                    text: $pushVM.webhook
                )
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    Task { await pushVM.saveWebhook(apiBase: settings.apiURL) }
                }
                Text("格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...；失焦或回车后保存")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Toggle("启用每日 10:00 自动推送", isOn: $pushVM.enabled)
                .onChange(of: pushVM.enabled) { newValue in
                    Task { await pushVM.saveEnabled(apiBase: settings.apiURL) }
                }
            HStack(spacing: 8) {
                Button("测试发送") {
                    Task { await pushVM.testSend(apiBase: settings.apiURL) }
                }
                .disabled(pushVM.testing)
                if pushVM.testing {
                    ProgressView().scaleEffect(0.7)
                }
            }
            if let msg = pushVM.feedback {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(pushVM.feedbackOk ? .green : .red)
            }
        }
    }

    // MARK: - 关于

    @ViewBuilder
    private var aboutSection: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: 64, height: 64)
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

// MARK: - 壁纸群推送 ViewModel

/// 「壁纸群推送」section 的状态与 HTTP 调用。
///
/// 设计要点：
/// - 使用 RelightClient 的同款 ephemeral URLSession（规避 URLSession.shared 的 HTTP 缓存陷阱，
///   「测试发送」尤其敏感——POST 若被缓存会读到旧响应）。
/// - webhook TextField `onSubmit` 触发保存（非每键实时，避免抖动）。
/// - 中文文案；HTTP 参照 ControlCenter.controlWorker() 的 URLRequest + httpMethod 模式。
@MainActor
final class PushSettingsViewModel: ObservableObject {
    @Published var webhook: String = ""
    @Published var enabled: Bool = false
    @Published var testing: Bool = false
    @Published var feedback: String?
    @Published var feedbackOk: Bool = false

    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.session = URLSession(configuration: config)
    }

    private func endpoint(_ apiBase: String, path: String) -> URL? {
        let base = apiBase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty else { return nil }
        return URL(string: "\(base)\(path)")
    }

    func load(apiBase: String) async {
        guard let url = endpoint(apiBase, path: "/api/push/settings") else { return }
        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                self.feedback = "加载失败：HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)"
                self.feedbackOk = false
                return
            }
            let decoded = try JSONDecoder().decode(PushSettingsResponse.self, from: data)
            self.webhook = decoded.data.webhook
            self.enabled = decoded.data.enabled
            self.feedback = nil
        } catch {
            self.feedback = "加载失败：\(error.localizedDescription)"
            self.feedbackOk = false
        }
    }

    func saveWebhook(apiBase: String) async {
        guard let url = endpoint(apiBase, path: "/api/push/settings") else { return }
        await put(url: url, body: ["webhook": webhook])
    }

    func saveEnabled(apiBase: String) async {
        guard let url = endpoint(apiBase, path: "/api/push/settings") else { return }
        await put(url: url, body: ["enabled": enabled])
    }

    private func put(url: URL, body: [String: Any]) async {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                self.feedback = "保存失败：无效响应"
                self.feedbackOk = false
                return
            }
            if !(200...299).contains(http.statusCode) {
                // 期望错误结构：{ success:false, error:"INVALID_WEBHOOK" }
                if let parsed = try? JSONDecoder().decode(PushSettingsErrorResponse.self, from: data) {
                    self.feedback = "保存失败：\(parsed.error)"
                } else {
                    self.feedback = "保存失败：HTTP \(http.statusCode)"
                }
                self.feedbackOk = false
                // webhook 非法时重新拉一次，让 UI 回到当前持久化值
                await reloadFromBackend(url)
                return
            }
            let decoded = try JSONDecoder().decode(PushSettingsResponse.self, from: data)
            self.webhook = decoded.data.webhook
            self.enabled = decoded.data.enabled
            self.feedback = "已保存"
            self.feedbackOk = true
        } catch {
            self.feedback = "保存失败：\(error.localizedDescription)"
            self.feedbackOk = false
        }
    }

    func testSend(apiBase: String) async {
        guard let url = endpoint(apiBase, path: "/api/push/test") else { return }
        testing = true
        defer { testing = false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                self.feedback = "测试失败：无效响应"
                self.feedbackOk = false
                return
            }
            if !(200...299).contains(http.statusCode) {
                self.feedback = "测试失败：HTTP \(http.statusCode)"
                self.feedbackOk = false
                return
            }
            // 解析 {success, data?, error?}，按 success 展示
            if let parsed = try? JSONDecoder().decode(PushTestResponse.self, from: data) {
                if parsed.success {
                    self.feedback = "测试发送成功（errcode=0）"
                    self.feedbackOk = true
                } else if let err = parsed.error {
                    let detail = parsed.data.map { " errcode=\($0.errcode)" } ?? ""
                    self.feedback = "测试失败：\(err)\(detail)"
                    self.feedbackOk = false
                } else {
                    self.feedback = "测试失败：未知错误"
                    self.feedbackOk = false
                }
            } else {
                self.feedback = "测试失败：响应解析失败"
                self.feedbackOk = false
            }
        } catch {
            self.feedback = "测试失败：\(error.localizedDescription)"
            self.feedbackOk = false
        }
    }

    private func reloadFromBackend(_ url: URL) async {
        // PUT 失败后重新 GET 同 URL
        let getURL = url
        do {
            let (data, response) = try await session.data(from: getURL)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { return }
            let decoded = try JSONDecoder().decode(PushSettingsResponse.self, from: data)
            self.webhook = decoded.data.webhook
            self.enabled = decoded.data.enabled
        } catch {
            // ignore：保留当前 UI 值
        }
    }
}

// MARK: - Codable

private struct PushSettingsData: Codable {
    let webhook: String
    let enabled: Bool
}

private struct PushSettingsResponse: Codable {
    let success: Bool
    let data: PushSettingsData
}

private struct PushSettingsErrorResponse: Codable {
    let success: Bool
    let error: String
}

private struct PushTestData: Codable {
    let errcode: Int?
    let errmsg: String?
}

private struct PushTestResponse: Codable {
    let success: Bool
    let data: PushTestData?
    let error: String?
}
