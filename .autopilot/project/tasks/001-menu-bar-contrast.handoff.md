# 001-menu-bar-contrast Handoff

**Commit**: `54b8193`
**完成时间**: 2026-05-17
**状态**: ✅ done

## 实现摘要

Mac 菜单栏图标加 `.renderingMode(.template)` 让 macOS 系统自动按菜单栏前景色（深色菜单栏白色 / 浅色菜单栏黑色）反色处理；同时加 `.accessibilityLabel(healthMonitor.accessibilityLabel)` 为 VoiceOver 用户提供状态语义。

## 文件变更

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/mac/Relight/RelightApp.swift` | +2 | MenuBarExtra label 的 Image 链增加 `.renderingMode(.template)` + `.accessibilityLabel(...)` |
| `apps/mac/Relight/UI/ControlCenter.swift` | +9 | `MenuBarHealthMonitor` 新增 `accessibilityLabel: String` 计算属性，4 case 中文（running/degraded/down/nil）|

净增 11 行，0 行删除。无 pbxproj 改动（无新 .swift 文件）。

## 下游须知

- 002 / 003 / 004 不依赖本任务，可独立推进
- `MenuBarHealthMonitor` 的 `accessibilityLabel` 计算属性已与 `iconName` 同位置（class 内紧邻），未来扩展 overall 第 5 态时**同时更新**两处 switch
- `.renderingMode(.template)` 会让 SwiftUI 强制按菜单栏前景色染色，**未来不要给菜单栏 Image 加 `.foregroundColor`**（无效）

## 偏差说明

无。设计与实现完全一致：2 文件、+11 行、4 case 中文字符串、不动 iconName 三态映射。

## QA 摘要

- Wave 1 Tier 0 acceptance-checklist 20/20 ✅
- Wave 1 Tier 1 xcodebuild BUILD SUCCEEDED
- Wave 1.5: 4 场景齐全（E=4=N），C（workers stop→API down→restore）/ D（编译）✅；A/B（深/浅色截图）保持 ⚠️ 测试环境限制（自动化无 CV + 切换外观破坏 session），代码契约已在 Tier 0 验证 + Apple SwiftUI `.template` 契约保证
- Wave 2 qa-reviewer Section A 6/6 + Section B 无问题
