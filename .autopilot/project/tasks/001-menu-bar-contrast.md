---
id: 001-menu-bar-contrast
depends_on: []
---

# 任务 001 — 菜单栏图标 .template + 暗色对比修复

## 目标（一句话）

让菜单栏图标在 macOS 深色/浅色菜单栏下都清晰可辨，且状态变化（running / degraded / down）视觉上可区分。

## 架构上下文

- 单文件改动：`apps/mac/Relight/RelightApp.swift` 第 60 行附近的 `MenuBarExtra` label
- `MenuBarHealthMonitor` 定义在 `apps/mac/Relight/UI/ControlCenter.swift`，已有 `iconName: String` 属性（switch overall: running → "photo.stack", degraded → "exclamationmark.triangle.fill", down → "xmark.octagon.fill", nil → "photo.stack"）
- 现状问题：`Image(systemName: healthMonitor.iconName)` 直接用，**未加 `.renderingMode(.template)`**，macOS 在深色菜单栏下可能不自动反色

## 输入契约

- 现有：`MenuBarHealthMonitor.iconName` 已经按 overall 状态返回不同 SF Symbol 名
- 现有：`MenuBarExtra { content } label: { Image(...) }` 结构

## 输出契约

- `Image(systemName: ...)` 链上加 `.renderingMode(.template)`，让 macOS 自动处理菜单栏深浅模式反色
- 不引入彩色 icon（菜单栏会强制灰度化）
- iconName 三态 → 视觉上必须可区分（已经是不同 SF Symbol，加 template 后形态差异不变）

## 验收标准

- 红队 acceptance test（如果项目允许 Swift 测试）：构造 `MenuBarHealthMonitor` 不同状态 → 检查 iconName 值；UI 部分用 snapshot 或人工截图
- Tier 1.5 真实场景：
  1. macOS 深色菜单栏下截图，图标清晰
  2. macOS 浅色菜单栏下截图，图标清晰
  3. `pnpm workers:stop` → 等 30s → 菜单栏图标切换为 degraded/down 视觉

## 范围控制

- ❌ 不改 `iconName` 的三态映射
- ❌ 不动 `MenuBarHealthMonitor` 轮询逻辑（30s）
- ❌ 不引入 NSImage / 自定义渲染（保持 SwiftUI）
- ✅ 仅在 Image 链上加 modifier；可选附加 `accessibilityLabel` 提升可访问性
