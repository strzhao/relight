import SwiftUI
import OSLog

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

    struct Repository: Codable {
        let photoCount: Int
        let todayAdded: Int
        let pendingAnalysis: Int
        let storageBytes: Int
    }
}

// MARK: - View Model

@MainActor
final class RuntimeStatusViewModel: ObservableObject {
    @Published var status: RuntimeStatus?
    @Published var lastError: String?
    @Published var lastFetchAt: Date?

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
            } else {
                self.lastError = decoded.error?.message ?? "no data"
            }
        } catch {
            // 网络挂了 → status 不变，但显示错误
            lastError = error.localizedDescription
            logger.warning("fetch runtime status failed: \(error.localizedDescription)")
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
                PlaceholderPage(title: "报告", hint: "扫描/分析/精选的趋势图表 — 后续上线")
            case .logs:
                PlaceholderPage(title: "日志", hint: "tail ~/.relight/logs/* — 后续上线")
            case .settings:
                PlaceholderPage(title: "设置", hint: "目前请用 ⌘, 打开系统设置窗口；后续整合到此处")
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .onAppear { viewModel.startPolling() }
        .onDisappear { viewModel.stopPolling() }
    }
}

// MARK: - Services Page

struct ServicesPage: View {
    @ObservedObject var viewModel: RuntimeStatusViewModel
    @EnvironmentObject var settings: AppSettings

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
            Button {
                openWeb()
            } label: {
                Label("打开 Web", systemImage: "safari")
            }
            Button {
                Task { await viewModel.fetchOnce() }
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            Spacer()
            Button("启动", action: {}).disabled(true)
            Button("停止", action: {}).disabled(true)
            Button("重启", action: {}).disabled(true)
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
        // Web 端口暂时还是固定 3001（后续 P0 把动态端口写到 runtime.json 后再读）
        let baseURL = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if let host = URL(string: baseURL)?.host {
            let webURL = URL(string: "http://\(host):3001")!
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
