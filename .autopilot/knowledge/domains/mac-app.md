# macOS App (SwiftUI)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 模式与教训

### [2026-05-07] xcodebuild ad-hoc 签名打包不能加 CODE_SIGNING_ALLOWED=NO

<!-- tags: xcodebuild, mac, code-signing, ad-hoc, hardened-runtime, gatekeeper, archive, bug -->

**Lesson**: ad-hoc 签名打包的最小有效组合是 `CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO`，不要追加 `CODE_SIGNING_ALLOWED=NO`（完全禁用签名工具链，与 ad-hoc 互斥）。

---

### [2026-05-07] Release+Hardened Runtime+LSUIElement APP 的 stdout 在 terminal 调用时会被吞

<!-- tags: macos, swiftui, hardened-runtime, lsuielement, stdout, release-build, debug-vs-release, code-signing -->

**Lesson**: GUI APP 二进制被 macOS 视为 NSApplication 主进程，不会自动绑定到调用方 terminal 的 stdout/stderr。调试和 SelfTest 类回归测试必须使用 Debug 构建。

---

### [2026-05-08] macOS App 行为异常先比 binary mtime vs 源码 mtime — 三路径独立易错位

<!-- tags: macos, xcode, debug, derived-data, stale-build, swiftui, lsuielement, scene, debugging-pattern, bug -->

**Lesson**: Xcode Cmd+R 跑的是 DerivedData、`./build.sh` 跑的是 `build/dist/`、Spotlight 启动的是 `/Applications/`——三个路径互不覆盖。诊断第一步先核对运行的 binary 是不是最新的。

---

### [2026-05-17] SwiftUI MenuBarExtra Image 默认不自动 .template，必须显式 .renderingMode(.template)

<!-- tags: swiftui, menubarextra, image, renderingmode, template, macos, dark-mode, status-icon, accessibility -->

**Lesson**: 给菜单栏 Image 必须显式加 `.renderingMode(.template)`。状态语义靠不同 SF Symbol 形态区分，不能靠颜色。加 `.accessibilityLabel(...)` 提供 VoiceOver 语义。

---

### [2026-05-17] SwiftUI ScrollView auto-follow 在 macOS 13 deployment target 不能用 DragGesture

<!-- tags: swiftui, scrollview, scrollviewreader, draggesture, trackpad, macos, deployment-target, auto-follow, log-viewer, ui-degradation -->

**Lesson**: macOS trackpad 滚动不触发 DragGesture。macOS 13 用按钮版（暂停跟随 + 回到底部），14+ 用 onScrollGeometryChange。

---

### [2026-06-13] MenuBarExtra 按钮中 `Task { }` 被菜单关闭立即取消，必须用 `Task.detached { }`

<!-- tags: swiftui, menubarextra, task-lifecycle, task-detached, mac-app, concurrency, bug -->

**Lesson**: MenuBarExtra 按钮中的异步操作必须用 `Task.detached { }`（完全独立的非结构化任务，不关联任何视图/actor 生命周期）。

---

### [2026-06-13] macOS 同名文件壁纸缓存：NSWorkspace.setDesktopImageURL 不读新文件

<!-- tags: macos, wallpaper, nsworkspace, setDesktopImageURL, image-cache, file-path-cache, mac-app, bug -->

**Lesson**: 每次设置壁纸必须使用唯一文件路径（加时间戳），确保 macOS 无法命中路径缓存，强制读取新文件。

---

### [2026-06-13] NSAppleScript 在 sandboxed/LSUIElement App 中不可靠 → 用 Process() 调 osascript

<!-- tags: macos, applescript, nsapplescript, nstask, process, osascript, sandbox, lsuielement, mac-app -->

**Lesson**: LSUIElement App 中 NSAppleScript 执行 System Events 相关脚本时有权限限制。应改用 `Process()`（NSTask）直接启动 `/usr/bin/osascript` 子进程。

---

### [2026-06-13] Xcode 增量编译不更新 MenuBarExtra 视图代码 — clean build 可解

<!-- tags: xcode, incremental-build, clean-build, swiftui, menubarextra, build-cache, mac-app, bug -->

**Lesson**: 修改 SwiftUI 视图代码后行为不一致时，必须 `clean build`。增量编译器对某些 SwiftUI 声明式代码的依赖追踪不可靠。

---

### [2026-06-13] URLSession.shared 默认 HTTP 缓存导致 wallpaper API 永远返回旧响应

<!-- tags: urlsession, http-cache, ephemeral, foundation, networking, mac-app, bug -->

**Lesson**: 对于需要实时数据的请求，使用 `URLSessionConfiguration.ephemeral` 创建无持久化缓存的 session。
