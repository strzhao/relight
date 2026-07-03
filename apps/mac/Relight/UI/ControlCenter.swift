import SwiftUI
import OSLog
import UserNotifications

private let logger = Logger(subsystem: "app.relight.mac", category: "ControlCenter")

// MARK: - Runtime Status Model（对应后端 /api/runtime/status）

struct RuntimeStatus: Codable {
    enum ServiceStatus: String, Codable {
        case running
        case degraded
        case down
    }

    let overall: ServiceStatus
    let version: String
    let services: Services
    let repository: Repository?

    struct Services: Codable {
        let api: ApiService
        let workers: WorkersService
        let redis: RedisService
        let cron: CronService
        let storage: StorageService?
    }

    struct ApiService: Codable {
        let status: ServiceStatus
        let port: Int
        let uptimeSec: Int
        let pid: Int
    }

    struct WorkersService: Codable {
        let status: ServiceStatus
        let lastHeartbeatAgoSec: Int?
        let commit: String?
        let queueDepth: QueueDepth?
    }

    struct QueueDepth: Codable {
        let scan: Int
        let analyze: Int
        let daily: Int
        let faces: Int

        var total: Int { scan + analyze + daily + faces }
    }

    struct RedisService: Codable {
        let status: ServiceStatus
        let latencyMs: Int?
    }

    struct CronService: Codable {
        let status: ServiceStatus
        let lastDailyPickDate: String?
        let nextRunAt: String?
    }

    /// 存储源可达性聚合（可选——后端旧版本无此字段时 nil）
    struct StorageService: Codable {
        let status: ServiceStatus
        let degradedCount: Int
        let downCount: Int
        let sources: [StorageSourceHealth]
    }

    struct StorageSourceHealth: Codable {
        let id: String
        let name: String
        /// "healthy" | "inaccessible" | "unmounted" | "permission_denied" | "unknown"
        let status: String
        let lastError: String?
    }

    struct Repository: Codable {
        let photoCount: Int
        let todayAdded: Int
        let pendingAnalysis: Int
        let storageBytes: Int
    }
}

// MARK: - Worker Control Models

enum WorkerAction: String {
    case start, stop, reload
}

struct WorkerControlResponse: Codable {
    let success: Bool
    let stdout: String
    let stderr: String
    let exitCode: Int
}

enum WorkerControlError: LocalizedError {
    case httpError(Int, String)
    case decodeFailed(Error)
    var errorDescription: String? {
        switch self {
        case .httpError(let code, let body): return "HTTP \(code): \(body)"
        case .decodeFailed(let e): return "解析失败: \(e.localizedDescription)"
        }
    }
}

// MARK: - Workers Logs & Runtime Config Models

struct WorkersLogs: Codable {
    let stdout: [String]
    let stderr: [String]
}

struct RuntimeConfigData: Codable {
    let storageRoot: String
    let aiBaseUrl: String
    let aiModel: String
    let aiVisionModel: String
    let redisUrl: String
    let databasePath: String
    let bullmqPrefix: String
    let aiApiKey: String
    let webPort: Int
}

// MARK: - View Model

@MainActor
final class RuntimeStatusViewModel: ObservableObject {
    @Published var status: RuntimeStatus?
    @Published var lastError: String?
    @Published var lastFetchAt: Date?
    /** 缓存 RuntimeConfig（一次性加载，几乎不变；openWeb 等读 webPort 用） */
    @Published var cachedConfig: RuntimeConfigData?

    /// 存储健康上次快照（sourceId → status），进程内去抖，状态翻转才弹通知
    private var lastStorageSnapshot: [String: String] = [:]

    private var pollingTask: Task<Void, Never>?
    private let settings: AppSettings

    init(settings: AppSettings = .shared) {
        self.settings = settings
    }

    func startPolling(every seconds: TimeInterval = 5) {
        stopPolling()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetchOnce()
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    func fetchOnce() async {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/runtime/status") else {
            lastError = "无效的 API URL"
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                lastError = "HTTP \( (response as? HTTPURLResponse)?.statusCode ?? 0 )"
                return
            }
            let decoded = try JSONDecoder().decode(ApiResponse<RuntimeStatus>.self, from: data)
            if let s = decoded.data {
                self.status = s
                self.lastError = nil
                self.lastFetchAt = Date()
                checkStorageHealthFlip(in: s)
            } else {
                self.lastError = decoded.error?.message ?? "no data"
            }
        } catch {
            // 网络挂了 → status 不变，但显示错误
            lastError = error.localizedDescription
            logger.warning("fetch runtime status failed: \(error.localizedDescription)")
        }
    }

    /// 检测存储健康状态翻转（healthy ↔ unhealthy），翻转时弹系统通知。
    /// 首次见到某源且 healthy → 不告警；首次见到且 unhealthy → 告警（mac 重启后重弹提醒用户）。
    private func checkStorageHealthFlip(in status: RuntimeStatus) {
        guard let storage = status.services.storage else { return }
        let unhealthy: Set<String> = ["inaccessible", "unmounted", "permission_denied"]
        var newSnapshot: [String: String] = [:]
        for src in storage.sources {
            newSnapshot[src.id] = src.status
            let prev = lastStorageSnapshot[src.id]
            if prev == src.status { continue }   // 状态未变 → 去抖
            let nowUnhealthy = unhealthy.contains(src.status)
            if prev == nil && !nowUnhealthy { continue }   // 首启正常 → 不轰炸
            let title = nowUnhealthy ? "存储源不可达" : "存储源已恢复"
            let body = nowUnhealthy
                ? "\(src.name)：\(src.lastError ?? "请检查 NAS 挂载")"
                : "\(src.name) 已可正常访问"
            sendStorageNotification(title: title, body: body, sourceId: src.id, status: src.status)
        }
        lastStorageSnapshot = newSnapshot
    }

    private func sendStorageNotification(title: String, body: String, sourceId: String, status: String) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(
            identifier: "storage-health-\(sourceId)-\(status)",
            content: content,
            trigger: nil
        )
        center.add(req) { error in
            if let e = error {
                logger.warning("存储健康通知发送失败: \(e.localizedDescription)")
            }
        }
    }

    @MainActor
    func fetchLogs(lines: Int = 200) async throws -> WorkersLogs {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/runtime/workers/logs?lines=\(lines)") else {
            throw URLError(.badURL)
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ApiResponse<WorkersLogs>.self, from: data).data
            ?? WorkersLogs(stdout: [], stderr: [])
    }

    @MainActor
    func fetchConfig() async throws -> RuntimeConfigData {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/runtime/config") else {
            throw URLError(.badURL)
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        guard let decoded = try JSONDecoder().decode(ApiResponse<RuntimeConfigData>.self, from: data).data else {
            throw URLError(.cannotParseResponse)
        }
        self.cachedConfig = decoded
        return decoded
    }

    @MainActor
    func controlWorker(_ action: WorkerAction) async throws -> WorkerControlResponse {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/runtime/workers/\(action.rawValue)") else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        if !(200...299).contains(http.statusCode) {
            // 500 解码尝试 — 提取 stderr 字段比 raw JSON 串更友好
            let body = String(data: data, encoding: .utf8) ?? ""
            if let parsed = try? JSONDecoder().decode(WorkerControlResponse.self, from: data),
               !parsed.stderr.isEmpty {
                throw WorkerControlError.httpError(http.statusCode, parsed.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            throw WorkerControlError.httpError(http.statusCode, body)
        }
        do {
            return try JSONDecoder().decode(WorkerControlResponse.self, from: data)
        } catch {
            throw WorkerControlError.decodeFailed(error)
        }
    }
}

// MARK: - Sidebar

enum ControlCenterSection: String, CaseIterable, Identifiable {
    case services = "服务"
    case reports = "报告"
    case logs = "日志"
    case settings = "设置"

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .services: return "server.rack"
        case .reports: return "chart.bar"
        case .logs: return "doc.text"
        case .settings: return "gear"
        }
    }
}

// MARK: - Main View

struct ControlCenterView: View {
    @StateObject private var viewModel = RuntimeStatusViewModel()
    @EnvironmentObject var settings: AppSettings
    @State private var selection: ControlCenterSection? = .services

    var body: some View {
        NavigationSplitView {
            List(ControlCenterSection.allCases, selection: $selection) { section in
                NavigationLink(value: section) {
                    Label(section.rawValue, systemImage: section.systemImage)
                }
            }
            .navigationTitle("拾光")
            .frame(minWidth: 160)
        } detail: {
            switch selection ?? .services {
            case .services:
                ServicesPage(viewModel: viewModel)
            case .reports:
                ReportsPage()
                    .environmentObject(viewModel)
                    .environmentObject(settings)
            case .logs:
                LogsPage()
                    .environmentObject(viewModel)
            case .settings:
                SettingsPage()
                    .environmentObject(viewModel)
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .onAppear {
            viewModel.startPolling()
            // 预拉 RuntimeConfig 让 cachedConfig.webPort 提前就绪给 openWeb() 用（不阻塞 UI）
            Task { _ = try? await viewModel.fetchConfig() }
        }
        .onDisappear { viewModel.stopPolling() }
    }
}

// MARK: - Services Page

struct ServicesPage: View {
    @ObservedObject var viewModel: RuntimeStatusViewModel
    @EnvironmentObject var settings: AppSettings
    @State private var pendingAction: WorkerAction?
    @State private var operationError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                serviceCards
                if let repo = viewModel.status?.repository {
                    RepositoryCard(repo: repo)
                }
                actionBar
                Spacer(minLength: 8)
                footer
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle()
                .fill(overallColor)
                .frame(width: 10, height: 10)
            Text(overallLabel)
                .font(.title2.bold())
            if let v = viewModel.status?.version {
                Text("v\(v)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if let err = viewModel.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
            }
        }
    }

    private var serviceCards: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            ServiceCard(
                title: "API",
                status: viewModel.status?.services.api.status,
                detail: apiDetail
            )
            ServiceCard(
                title: "Workers",
                status: viewModel.status?.services.workers.status,
                detail: workersDetail
            )
            ServiceCard(
                title: "Redis",
                status: viewModel.status?.services.redis.status,
                detail: redisDetail
            )
            ServiceCard(
                title: "Cron",
                status: viewModel.status?.services.cron.status,
                detail: cronDetail
            )
        }
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            Button { openWeb() } label: { Label("打开 Web", systemImage: "safari") }
            Button { Task { await viewModel.fetchOnce() } } label: { Label("刷新", systemImage: "arrow.clockwise") }
            Spacer()

            let workersStatus = viewModel.status?.services.workers.status

            Button("启动") { pendingAction = .start }
                .disabled(workersStatus != .down)

            Button("停止") { pendingAction = .stop }
                .disabled(workersStatus != .running)

            Button("重启") { pendingAction = .reload }
                .disabled(workersStatus != .running)
        }
        .confirmationDialog(
            confirmTitle(for: pendingAction),
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            presenting: pendingAction
        ) { action in
            Button(confirmButtonLabel(for: action), role: action == .stop ? .destructive : nil) {
                Task {
                    do {
                        _ = try await viewModel.controlWorker(action)
                        await viewModel.fetchOnce()
                    } catch {
                        operationError = error.localizedDescription
                    }
                }
            }
            Button("取消", role: .cancel) { }
        } message: { action in
            Text(confirmMessage(for: action))
        }
        .alert(
            "操作失败",
            isPresented: Binding(
                get: { operationError != nil },
                set: { if !$0 { operationError = nil } }
            )
        ) {
            Button("好") { }
        } message: {
            Text(operationError ?? "")
        }
    }

    private func confirmTitle(for action: WorkerAction?) -> String {
        switch action {
        case .start: return "启动 workers"
        case .stop: return "停止 workers"
        case .reload: return "重启 workers"
        case nil: return ""
        }
    }

    private func confirmButtonLabel(for action: WorkerAction) -> String {
        switch action {
        case .start: return "启动"
        case .stop: return "停止"
        case .reload: return "重启"
        }
    }

    private func confirmMessage(for action: WorkerAction) -> String {
        switch action {
        case .start: return "将启动后台扫描与分析进程。"
        case .stop: return "workers 停止后扫描和分析将暂停。"
        case .reload: return "重启会中断当前正在分析的任务，已分析过的不重做。"
        }
    }

    private var footer: some View {
        HStack {
            if let t = viewModel.lastFetchAt {
                Text("最后更新 \(t.formatted(.dateTime.hour().minute().second()))")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    private var overallColor: Color {
        guard let s = viewModel.status?.overall else { return .gray }
        switch s {
        case .running: return .green
        case .degraded: return .yellow
        case .down: return .red
        }
    }

    private var overallLabel: String {
        guard let s = viewModel.status?.overall else { return "未连接" }
        switch s {
        case .running: return "运行中"
        case .degraded: return "降级运行"
        case .down: return "异常"
        }
    }

    private var apiDetail: String {
        guard let api = viewModel.status?.services.api else { return "—" }
        let uptime = formatUptime(api.uptimeSec)
        return ":\(api.port) · uptime \(uptime)"
    }

    private var workersDetail: String {
        guard let w = viewModel.status?.services.workers else { return "—" }
        let depth = w.queueDepth.map { "队列 \($0.total)" } ?? ""
        let heartbeat = w.lastHeartbeatAgoSec.map { "心跳 \($0)s 前" } ?? "未发现"
        return [heartbeat, depth].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var redisDetail: String {
        guard let r = viewModel.status?.services.redis else { return "—" }
        return r.latencyMs.map { "\($0)ms" } ?? "无连接"
    }

    private var cronDetail: String {
        guard let c = viewModel.status?.services.cron else { return "—" }
        if let last = c.lastDailyPickDate {
            return "上次精选 \(last)"
        }
        return "未触发"
    }

    private func formatUptime(_ sec: Int) -> String {
        if sec < 60 { return "\(sec)s" }
        if sec < 3600 { return "\(sec / 60)m" }
        if sec < 86400 { return "\(sec / 3600)h" }
        return "\(sec / 86400)d"
    }

    private func openWeb() {
        // Web 端口从 RuntimeConfig.webPort 读取（默认 3601，可由 WEB_PORT env 覆盖）。
        // 缓存未就绪时（首次启动还没拉 config）fallback 到 3601。
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if let host = URL(string: baseURL)?.host {
            let port = viewModel.cachedConfig?.webPort ?? 3601
            let webURL = URL(string: "http://\(host):\(port)")!
            NSWorkspace.shared.open(webURL)
        }
    }
}

// MARK: - Cards

struct ServiceCard: View {
    let title: String
    let status: RuntimeStatus.ServiceStatus?
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(title)
                    .font(.headline)
                Spacer()
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    private var color: Color {
        guard let s = status else { return .gray }
        switch s {
        case .running: return .green
        case .degraded: return .yellow
        case .down: return .red
        }
    }

    private var label: String {
        guard let s = status else { return "—" }
        switch s {
        case .running: return "running"
        case .degraded: return "degraded"
        case .down: return "down"
        }
    }
}

struct RepositoryCard: View {
    let repo: RuntimeStatus.Repository

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("仓库")
                .font(.headline)
            HStack(spacing: 24) {
                stat(label: "照片", value: "\(repo.photoCount)")
                stat(label: "今日新增", value: "\(repo.todayAdded)")
                stat(label: "待分析", value: "\(repo.pendingAnalysis)")
                stat(label: "存储", value: formatBytes(repo.storageBytes))
                Spacer()
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    private func stat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title3.weight(.semibold))
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var unit = 0
        while value >= 1024 && unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        return String(format: "%.1f%@", value, units[unit])
    }
}

// MARK: - Menu Bar Health Monitor

/// 轻量级独立轮询器，给菜单栏图标提供 overall 状态。
/// 与 RuntimeStatusViewModel 解耦：控制中心 5s 一次，菜单栏 30s 一次。
@MainActor
final class MenuBarHealthMonitor: ObservableObject {
    @Published var overall: RuntimeStatus.ServiceStatus?

    private var pollingTask: Task<Void, Never>?
    private let settings: AppSettings

    init(settings: AppSettings = .shared) {
        self.settings = settings
    }

    func start(every seconds: TimeInterval = 30) {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetchOnce()
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    private func fetchOnce() async {
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(baseURL)/api/runtime/status") else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                self.overall = .down
                return
            }
            let decoded = try JSONDecoder().decode(ApiResponse<RuntimeStatus>.self, from: data)
            self.overall = decoded.data?.overall
        } catch {
            self.overall = .down
        }
    }

    /// 菜单栏 SF Symbol：根据 overall 切换图标。
    var iconName: String {
        switch overall {
        case .running: return "photo.stack"
        case .degraded: return "exclamationmark.triangle.fill"
        case .down: return "xmark.octagon.fill"
        case nil: return "photo.stack"
        }
    }

    var accessibilityLabel: String {
        switch overall {
        case .running: return "拾光 — 服务正常"
        case .degraded: return "拾光 — 服务降级"
        case .down: return "拾光 — 服务离线"
        case nil: return "拾光 — 状态未知"
        }
    }
}

// MARK: - Placeholder

struct PlaceholderPage: View {
    let title: String
    let hint: String

    var body: some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.title.bold())
                .foregroundStyle(.secondary)
            Text(hint)
                .font(.callout)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
