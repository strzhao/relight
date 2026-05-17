import SwiftUI

struct LogsPage: View {
    @EnvironmentObject var viewModel: RuntimeStatusViewModel
    @State private var logs: WorkersLogs = WorkersLogs(stdout: [], stderr: [])
    @State private var pollingTask: Task<Void, Never>?
    @State private var userScrolledUp = false
    @State private var errorMsg: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(logs.stdout.enumerated()), id: \.offset) { idx, line in
                            Text(line)
                                .font(.system(.caption, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id("stdout-\(idx)")
                        }
                        if !logs.stderr.isEmpty {
                            Divider().padding(.vertical, 4)
                            Text("─── stderr ───")
                                .font(.caption)
                                .foregroundStyle(.red.opacity(0.7))
                            ForEach(Array(logs.stderr.enumerated()), id: \.offset) { idx, line in
                                Text(line)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.red.opacity(0.8))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .id("stderr-\(idx)")
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                }
                .onChange(of: logs.stdout.count) { _ in
                    if !userScrolledUp {
                        withAnimation(.linear(duration: 0.1)) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                HStack {
                    if userScrolledUp {
                        Button("暂停跟随 — 点击回到底部") {
                            userScrolledUp = false
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                        .controlSize(.small)
                    } else {
                        Button("暂停跟随") {
                            userScrolledUp = true
                        }
                        .controlSize(.small)
                    }
                    Spacer()
                    if let err = errorMsg {
                        Text("加载失败: \(err)")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
        .navigationTitle("日志")
        .task {
            pollingTask?.cancel()
            pollingTask = Task {
                while !Task.isCancelled {
                    await fetchLogs()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
        .onDisappear {
            pollingTask?.cancel()
            pollingTask = nil
        }
    }

    private func fetchLogs() async {
        do {
            self.logs = try await viewModel.fetchLogs(lines: 200)
            self.errorMsg = nil
        } catch {
            self.errorMsg = error.localizedDescription
        }
    }
}
