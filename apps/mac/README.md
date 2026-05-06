# Relight macOS App

拾光 macOS 客户端 — SwiftUI 原生应用。

## 环境要求

- macOS 13.0 (Ventura) 及以上
- Xcode 14.0 及以上（含 xcodebuild 命令行工具）
- Swift 5.0+

## 目录结构

```
apps/mac/
├── Relight.xcodeproj/      # Xcode 工程文件
│   └── project.pbxproj
└── Relight/                # 源代码
    ├── RelightApp.swift    # App 入口
    ├── ContentView.swift   # 主界面
    ├── Info.plist          # Bundle 配置
    └── Assets.xcassets/    # 图标资源
```

## 构建

### 命令行构建（Debug）

```bash
cd apps/mac
xcodebuild -project Relight.xcodeproj -scheme Relight -configuration Debug build \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO -derivedDataPath ./build
```

产物路径：`build/Build/Products/Debug/Relight.app`

### 命令行构建（Release，通过 pnpm）

```bash
# 从仓库根目录
pnpm --filter @relight/mac build
```

### 通过 Xcode IDE 打开

```bash
open apps/mac/Relight.xcodeproj
```

## 运行

```bash
open build/Build/Products/Debug/Relight.app
```

## 签名说明

当前使用 ad-hoc 签名（`CODE_SIGN_IDENTITY = -`），沙盒已关闭（`ENABLE_APP_SANDBOX = NO`），
适用于本地开发和测试。发布到 Mac App Store 时需配置正式证书和沙盒权限。

## Bundle 信息

| 字段 | 值 |
|------|-----|
| Bundle ID | `app.relight.mac` |
| 显示名称 | 拾光 |
| 最低系统版本 | macOS 13.0 |
| 当前版本 | 0.0.1 |
