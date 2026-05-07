import SwiftUI

struct GeneralSettingsTab: View {
    @EnvironmentObject var settings: AppSettings

    var body: some View {
        Form {
            Section("Relight 后端") {
                TextField("API URL", text: $settings.apiURL)
                    .textFieldStyle(.roundedBorder)
                Text("默认 http://localhost:3000，worktree 下用对应端口")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("启动") {
                Toggle("登录时自动启动", isOn: $settings.autoStart)
                Text("（需任务 006 完成 SMAppService 注册后生效）")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("状态") {
                if let date = settings.lastAppliedPickDate {
                    Text("上次设置壁纸：\(date)")
                } else {
                    Text("从未设置壁纸")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}
