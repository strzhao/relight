# Handoff — 001-mac-xcode-scaffold

**状态**: done | **commit**: 060a793 | **完成时间**: 2026-05-07

## 工程位置和构建命令

- **Xcode 工程**: `apps/mac/Relight.xcodeproj`
- **源码目录**: `apps/mac/Relight/`
- **Bundle ID**: `app.relight.mac`
- **部署目标**: macOS 13.0 Ventura
- **Swift 版本**: 5.0（Xcode 26.4.1 实测兼容）
- **沙盒**: 关闭（`ENABLE_APP_SANDBOX = NO`）
- **签名**: ad-hoc（`CODE_SIGN_IDENTITY = -`，自动签名 + Sign to Run Locally）
- **Hardened Runtime**: 开启（YES）— ⚠️ 后续任务若访问网络/文件系统遇权限拒绝可考虑关闭

**命令行构建**：
```bash
# Debug + 项目内 build/ 目录（验收脚本期望的路径）
cd apps/mac && xcodebuild -project Relight.xcodeproj -scheme Relight \
  -configuration Debug build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  -derivedDataPath ./build

# Release 直接通过 pnpm filter（产物落 ~/Library/Developer/Xcode/DerivedData/）
pnpm --filter @relight/mac build
```

> ⚠️ **已知不一致**：`apps/mac/package.json` 的 `build` script 缺 `-derivedDataPath ./build`，与验收脚本路径不一致。后续任务可顺手补一下。

## 已有源文件清单

```
apps/mac/
├── .gitignore
├── README.md                   (67 行 — 超出设计建议 ≤45，可裁减)
├── package.json                (@relight/mac，零 dependencies)
├── scaffold.acceptance.test.sh (红队 26 检查点黑盒验收脚本)
├── Relight.xcodeproj/project.pbxproj  (312 行手写 OpenStep plist，objectVersion=56)
└── Relight/
    ├── RelightApp.swift        (10 行 — @main + WindowGroup ContentView())
    ├── ContentView.swift       (12 行 — Text("Relight").padding())
    ├── Info.plist              (28 行 — 11 必备字段全齐)
    └── Assets.xcassets/
        ├── Contents.json
        └── AppIcon.appiconset/Contents.json
```

## 添加新 Swift 文件到 target（后续任务必读）

手写 .pbxproj 不像 Xcode GUI 自动管理，**新增 .swift 文件必须手动改 4 处**：

1. **PBXFileReference** section：声明文件，分配新 GUID（接续 `A00000000000000000000018` 之后）
2. **PBXGroup `Relight`** 的 children 数组：添加新 GUID
3. **PBXBuildFile** section：将 fileRef GUID 包装成 buildRef
4. **PBXSourcesBuildPhase** files 数组：添加 buildRef

**强烈建议**：后续任务（002+）若要批量添加 Swift 文件，**直接在每个任务内自行修订 pbxproj 时使用一致的 GUID 风格**（`A00000000000000000000018` 起递增）。或在某个任务（如 005 / 006）改用 xcodegen 重新生成 pbxproj — 此时务必先 commit 现有 pbxproj 作为 baseline。

## 已配置的 entitlements / Info.plist 关键键

- entitlements 文件：**无**（不需要，无沙盒）
- Info.plist 11 字段（**任务 002+ 不要漏改**）：
  - `CFBundleIdentifier=app.relight.mac` / `CFBundleName=Relight` / `CFBundleDisplayName=拾光`
  - `CFBundleExecutable=$(EXECUTABLE_NAME)` / `CFBundlePackageType=APPL`（缺则 APP 无法启动）
  - `CFBundleVersion=1` / `CFBundleShortVersionString=0.0.1`（任务 007 archive 时升级）
  - `LSMinimumSystemVersion=13.0` / `LSUIElement=false`（任务 005 改菜单栏 APP 时改 true）

## 后续任务对接点

- **任务 002（RelightClient）**：在 `apps/mac/Relight/` 下新建 `Models/`、`Networking/`、`Storage/`、`Settings/` 子目录，对应 4 处 pbxproj 修改照例办；遵循实际 API 响应（含 `fileMtime`，CFBundleExecutable 同理 — 以实际为准）
- **任务 005（菜单栏）**：把 `Info.plist` 的 `LSUIElement` 改成 `true`，让 Dock 不显示图标
- **任务 006（自启动）**：`SMAppService.mainApp` 不需要新增 entitlements，但**首次注册会触发系统授权弹窗**

## QA 验收摘要

- 红队脚本 26/26 ✅
- 5 真实场景 5/5 ✅（xcodebuild Debug/Release、APP 启动、pnpm install/typecheck/--filter build）
- qa-reviewer 88/100，4 个 ⚠️ 不阻塞（README 超长 / build script 路径 / Hardened Runtime / 红队 plist_check 覆盖盲区）
