# 模式与教训

> **已拆分** — 具体条目按领域迁移至 `domains/` 目录。
> 本文件保留为索引，指向各领域文件中的模式条目。

## 领域索引

- **[daily-selection](domains/daily-selection.md)** — 每日精选模式：去重窗口时区、对称窗口、弱操作 UI、字段同步
- **[face-recognition](domains/face-recognition.md)** — 人脸聚类陷阱：centroid 雪球、ArcFace 阈值分布
- **[backend-infra](domains/backend-infra.md)** — 后端模式：两层扩展名过滤、安全阀、危险脚本规范
- **[frontend](domains/frontend.md)** — 前端模式：flex 裁剪、IntersectionObserver 生命周期、SSR 注释、useRouter
- **[testing](domains/testing.md)** — 测试模式：红队 fixture bug、fake timer、jsdom 限制、vi.mock 路径、spawn mock timing
- **[mac-app](domains/mac-app.md)** — macOS App 模式：签名、stdout、stale build、MenuBarExtra、壁纸缓存、AppleScript
- **[ai-prompt](domains/ai-prompt.md)** — AI 模式：qwen3 思考禁用、第二人称陷阱、Whisper CLI 输出
- **[image-processing](domains/image-processing.md)** — 图片处理模式：SMB Buffer、HEIC 伪装、withoutEnlargement、exifr revive
- **[release-ops](domains/release-ops.md)** — 运维模式：PM2 reload、ESM 顶层 await、PATH 注入、CI xcodebuild
- **[database](domains/database.md)** — 数据库模式：onConflictDoNothing、async transaction、path.resolve

## 历史模式时间线

| 日期 | 模式 | 领域文件 |
|------|------|----------|
| 2026-06-13 | 新增图片路径须同步 RAW/DNG | [image-processing](domains/image-processing.md) |
| 2026-06-13 | 主实体 UPDATE 须同步关联派生字段 | [daily-selection](domains/daily-selection.md) |
| 2026-06-13 | MenuBarExtra Task.detached | [mac-app](domains/mac-app.md) |
| 2026-06-13 | macOS 同名文件壁纸缓存 | [mac-app](domains/mac-app.md) |
| 2026-06-13 | URLSession ephemeral 缓存 | [mac-app](domains/mac-app.md) |
| 2026-06-13 | Xcode 增量编译 clean build | [mac-app](domains/mac-app.md) |
| 2026-06-13 | NSAppleScript → Process() osascript | [mac-app](domains/mac-app.md) |
| 2026-06-13 | 壁纸双缓存失效陷阱 | [image-processing](domains/image-processing.md) |
| 2026-06-12 | 弱操作 UI 降权设计 | [daily-selection](domains/daily-selection.md) |
| 2026-06-02 | 去重窗口 UTC/北京时区跨天 | [daily-selection](domains/daily-selection.md) |
| 2026-06-02 | 30 天去重对称窗口 | [daily-selection](domains/daily-selection.md) |
| 2026-06-02 | PM2 env PATH 注入 | [release-ops](domains/release-ops.md) |
| 2026-06-02 | CI xcodebuild 双坑 | [release-ops](domains/release-ops.md) |
| 2026-05-19 | 客户端硬编码端口反模式 | [release-ops](domains/release-ops.md) |
| 2026-05-17 | BullMQ getRepeatableJobs id 陷阱 | [backend-infra](domains/backend-infra.md) |
| 2026-05-17 | pbxproj 4-section 文件引用 | [mac-app](domains/mac-app.md) |
| 2026-05-17 | MenuBarExtra Image .template | [mac-app](domains/mac-app.md) |
| 2026-05-17 | Hono localhost-only middleware | [backend-infra](domains/backend-infra.md) |
| 2026-05-17 | vitest spawn mock timing | [testing](domains/testing.md) |
| 2026-05-17 | ScrollView DragGesture 陷阱 | [mac-app](domains/mac-app.md) |
| 2026-05-15 | 红队 fixture 自身 bug | [testing](domains/testing.md) |
| 2026-05-15 | candidate-pool JOIN → fixture DDL | [testing](domains/testing.md) |
| 2026-05-15 | narrate 第二人称 AI 偏离 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-14 | ArcFace 边缘正例 cosine 分布 | [face-recognition](domains/face-recognition.md) |
| 2026-05-14 | flex align-items center 裁剪 | [frontend](domains/frontend.md) |
| 2026-05-14 | Satori object-fit 几何断言 | [image-processing](domains/image-processing.md) |
| 2026-05-14 | centroid 雪球 + 垃圾桶 cluster | [face-recognition](domains/face-recognition.md) |
| 2026-05-13 | 危险脚本 --help + --yes | [backend-infra](domains/backend-infra.md) |
| 2026-05-13 | vi.mock 相对路径基准 | [testing](domains/testing.md) |
| 2026-05-12 | HF 模型下载 URL 验证 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-12 | Biome [^] → [\s\S] | [testing](domains/testing.md) |
| 2026-05-11 | exifr reviveValues Date 陷阱 | [image-processing](domains/image-processing.md) |
| 2026-05-10 | vitest fake timer + React 19 | [testing](domains/testing.md) |
| 2026-05-10 | jsdom setPointerCapture + draggable | [testing](domains/testing.md) |
| 2026-05-10 | useRouter SSR invariant | [frontend](domains/frontend.md) |
| 2026-05-09 | React SSR 注释标记 | [frontend](domains/frontend.md) |
| 2026-05-09 | 红队 vi.mock vs 蓝队 api 对象 | [testing](domains/testing.md) |
| 2026-05-09 | drizzle async transaction 陷阱 | [database](domains/database.md) |
| 2026-05-08 | Drizzle onConflictDoNothing returning | [database](domains/database.md) |
| 2026-05-08 | tsup import.meta.url dev/prod | [image-processing](domains/image-processing.md) |
| 2026-05-08 | Satori jsxImportSource 路径 | [image-processing](domains/image-processing.md) |
| 2026-05-08 | macOS stale build 诊断 | [mac-app](domains/mac-app.md) |
| 2026-05-08 | callback ref vs useRef+useEffect | [frontend](domains/frontend.md) |
| 2026-05-08 | Playwright page.route glob ? | [testing](domains/testing.md) |
| 2026-05-07 | ESM 顶层 await 阻塞 import | [release-ops](domains/release-ops.md) |
| 2026-05-07 | PM2 reload in-flight job | [release-ops](domains/release-ops.md) |
| 2026-05-07 | xcodebuild CODE_SIGNING_ALLOWED | [mac-app](domains/mac-app.md) |
| 2026-05-07 | Release stdout 被吞 | [mac-app](domains/mac-app.md) |
| 2026-05-06 | path.resolve vs path.join | [database](domains/database.md) |
| 2026-05-06 | BullMQ Job mock 不完整 | [testing](domains/testing.md) |
| 2026-05-06 | 视频 daily-selection 读 cover JPEG | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-06 | Whisper CLI stdout vs 文件 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-06 | worktree symlink lint-staged | [release-ops](domains/release-ops.md) |
| 2026-05-05 | qwen3 思考模式禁用 | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-05 | sharp withoutEnlargement | [image-processing](domains/image-processing.md) |
| 2026-05-05 | HEIC 检测在 sharp 之前 | [image-processing](domains/image-processing.md) |
| 2026-05-05 | Next.js dev 不读 .env.local PORT | [frontend](domains/frontend.md) |
| 2026-05-05 | pnpm 子进程 cwd | [release-ops](domains/release-ops.md) |
| 2026-05-04 | 两层扩展名过滤 | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | 非 HEIC 图片 sharp resize | [ai-prompt](domains/ai-prompt.md) |
| 2026-05-04 | macOS SMB 挂载持久化 | [release-ops](domains/release-ops.md) |
| 2026-05-04 | HEIC 伪装 JPEG 降级 | [image-processing](domains/image-processing.md) |
| 2026-05-04 | Sharp SMB Buffer 路径 | [image-processing](domains/image-processing.md) |
| 2026-05-04 | IntersectionObserver 级联循环 | [frontend](domains/frontend.md) |
| 2026-05-04 | 安全阀防 NAS 断连误删 | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | Biome a11y overrides | [testing](domains/testing.md) |
| 2026-05-04 | SSE DB 轮询 + QueueEvents | [backend-infra](domains/backend-infra.md) |
| 2026-05-04 | Next.js rewrites SSE 不转发 | [frontend](domains/frontend.md) |
| 2026-05-03 | @tanstack virtual sentinel | [frontend](domains/frontend.md) |
| 2026-05-02 | BullMQ 重试 Queue 侧配置 | [backend-infra](domains/backend-infra.md) |
| 2026-05-01 | pnpm onlyBuiltDependencies | [release-ops](domains/release-ops.md) |
| 2026-05-01 | Vitest workspace 根安装 | [testing](domains/testing.md) |
| 2026-05-01 | Biome organizeImports 顶层键 | [testing](domains/testing.md) |
