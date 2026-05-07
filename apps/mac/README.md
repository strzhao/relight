# 拾光 macOS 壁纸 APP

拾光 mac 壁纸 APP 是「拾光」生态的桌面消费端，自动把后端每日精选（含图片和视频）设为桌面壁纸。视频精选会被转成 macOS 原生「动态 .heic」壁纸（24 小时按时间切换 16 帧）。应用常驻菜单栏，零打扰，让 AI 每天挑选的回忆「占据视野中央」。

## 环境要求

- macOS 13.0 (Ventura) 或更高（因使用 `SMAppService` 与 `SwiftUI MenuBarExtra`）
- Xcode 15+ 命令行工具（`xcode-select --install`）
- 拾光 backend 已运行（默认 `http://localhost:3000`，可在 APP 设置中修改）

## 快速开始

### 1. 启动 backend

在仓库根目录执行：

```bash
pnpm --filter @relight/backend dev
```

确认后端可达：

```bash
curl -sf http://localhost:3000/api/daily/today | jq .photo.id
```

输出非空 photo id 即表示后端就绪。

### 2. 构建 APP

**方式 A：命令行一键打包（推荐）**

```bash
# 从仓库根目录
pnpm --filter @relight/mac archive

# 或直接在 apps/mac 目录内运行
cd apps/mac
./build.sh
```

产物位置：`apps/mac/build/dist/Relight.app`

**方式 B：Xcode IDE**

```bash
open apps/mac/Relight.xcodeproj
```

在 Xcode 中选择 Scheme `Relight`，按 ⌘R 运行（Debug），或 Product → Archive 打包 Release。

### 3. 运行

```bash
open apps/mac/build/dist/Relight.app
```

首次运行 macOS 会弹出「无法验证开发者」警告，请前往「系统设置 → 隐私与安全」，在页面底部点击「仍要打开」放行。

## 使用说明

### 菜单栏交互

点击菜单栏图标（☀️ 拾光图标）弹出菜单：

| 菜单项 | 说明 |
|--------|------|
| 立即更新壁纸 | 立刻拉取今日精选并设置桌面壁纸 |
| 设置 | 打开设置面板 |
| 退出 | 退出 APP |

### 设置面板

- **API URL**：后端地址，默认 `http://localhost:3000`。如果使用 worktree 开发环境，改为对应 backend 端口（4001-4999 范围，由 worktree 名 hash 算出，可用 `pnpm worktree:setup` 查看）。
- **登录时自动启动**：开启后每次登录 macOS 自动启动 APP。

### 工作机制

- 启动时检查「上次应用日期 ≠ 今天」→ 自动拉取今日精选并设置壁纸
- 启动后每小时检查一次（北京时间 07:00 后才拉取，确保 daily-selection 任务已跑完）
- 用户可随时点「立即更新」手动触发

## 已知限制

- **ad-hoc 签名警告**：应用使用 ad-hoc 签名，首次运行 macOS 会显示「无法验证开发者」，需在「系统设置 → 隐私与安全」中手动放行。

- **视频壁纸切换由系统调度**：视频精选的 16 帧切换通过动态 .heic 实现，macOS 系统按 `.heic` 文件内 `apple_desktop:h24` 元数据自动按时间切换，APP 本身无法精确控制每帧的具体切换时刻。

- **早 6:00 前精选为空**：后端 `daily-selection` job 每天北京时间 6:00 运行。若在此之前触发更新，会拉到空响应，APP 静默跳过，等下次刷新时再试。

- **SMAppService 自启动在 macOS 14+ 可能失败**：macOS 14 (Sonoma) / 15 (Sequoia) 对未做 Hardened Runtime 的 ad-hoc 应用收紧了 `SMAppService` 注册策略，登录项注册可能静默失败。MVP 版本仅在 macOS 13 (Ventura) 上保证自启动可用；macOS 14+ 用户可在「系统设置 → 通用 → 登录项」中手动将 `Relight.app` 添加到列表。

## 调试

查看 APP 实时日志：

```bash
log stream --predicate 'subsystem == "app.relight.mac"' --info
```

或打开「Console.app」，在搜索框中输入：

```
subsystem:app.relight.mac
```

壁纸缓存文件位置：

```
~/Library/Application Support/Relight/wallpapers/
```

UserDefaults 检查（确认上次应用日期）：

```bash
defaults read app.relight.mac app.relight.lastAppliedPickDate
```

## Bundle 信息

| 字段 | 值 |
|------|-----|
| Bundle ID | `app.relight.mac` |
| 显示名称 | 拾光 |
| 最低系统版本 | macOS 13.0 |

## 后续扩展计划

- **多历史壁纸轮换**：保留最近 7 天精选，按周期轮换，不只展示当天一张
- **Sonoma Live Wallpaper 文件夹方案**（研究中）：macOS 14 Sonoma 支持指定视频文件夹作为屏保/壁纸，若 Apple 开放稳定 API 可替代当前动态 .heic 方案
- **Apple Developer 账号 + Notarize**：正式 Code Signing + 公证后可免去首次运行的安全警告，支持 Mac App Store 分发
- **自动检测 backend 进程**：若 backend 未启动，菜单栏给出提示并提供一键启动按钮
- **通知中心展示 narrative**：壁纸切换时在通知中心推送今日精选的 AI 叙事文案
