import SwiftUI

struct ReportsPage: View {
    @EnvironmentObject var viewModel: RuntimeStatusViewModel
    @EnvironmentObject var settings: AppSettings
    @State private var picks: [DailyPick] = []
    @State private var loading = false
    @State private var errorMsg: String?

    var body: some View {
        VStack {
            if loading && picks.isEmpty {
                ProgressView("加载中…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if picks.isEmpty {
                emptyView
            } else {
                List(picks) { pick in
                    HStack(spacing: 12) {
                        AsyncImage(url: composedImageURL(for: pick)) { phase in
                            switch phase {
                            case .success(let img):
                                img.resizable().aspectRatio(contentMode: .fill)
                            default:
                                Color.gray.opacity(0.2)
                            }
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pick.pickDate)
                                .font(.headline)
                            Text(pick.title)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("报告")
        .task { await load() }
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Text("暂无精选历史")
                .font(.title3)
                .foregroundStyle(.secondary)
            Button("立即生成") {
                Task { await triggerDaily() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func composedImageURL(for pick: DailyPick) -> URL? {
        guard let path = pick.composedImageUrl else { return nil }
        let base = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(string: "\(base)\(path)")
    }

    private func load() async {
        loading = true
        errorMsg = nil
        defer { loading = false }
        do {
            let base = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: "\(base)/api/daily?page=1&pageSize=30") else { return }
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoded = try JSONDecoder().decode(DailyListResponse.self, from: data)
            self.picks = decoded.data
        } catch {
            self.errorMsg = error.localizedDescription
        }
    }

    private func triggerDaily() async {
        let base = settings.apiURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: "\(base)/api/daily/trigger") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        _ = try? await URLSession.shared.data(for: req)
        await load()
    }
}

private struct DailyListResponse: Codable {
    let success: Bool
    let data: [DailyPick]
    let total: Int
    let page: Int
    let pageSize: Int
}
