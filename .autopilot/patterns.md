# 模式与教训

### [2026-05-01] pnpm 原生模块构建需在 package.json 中声明 onlyBuiltDependencies
<!-- tags: pnpm, native-modules, build -->

**Scenario**: 新 monorepo 安装依赖时，pnpm 默认阻止 better-sqlite3、sharp、esbuild、@biomejs/biome 等原生模块的构建脚本。

**Lesson**: 在根 `package.json` 中添加 `pnpm.onlyBuiltDependencies` 数组，而非使用交互式 `pnpm approve-builds`（后者在 CI/脚本中不可用）。

**Evidence**: `pnpm install` 输出 "Ignored build scripts: @biomejs/biome@1.9.4, better-sqlite3@11.10.0, esbuild@..., sharp@..."。在 package.json 添加配置后 `pnpm install` 自动构建成功。

### [2026-05-01] Vitest workspace 模式需在根级别安装 vitest
<!-- tags: vitest, monorepo, testing -->

**Scenario**: 使用 `vitest.workspace.ts` 定义多项目测试配置，但 `pnpm test` 报 `vitest: command not found`。

**Lesson**: vitest.workspace.ts 由根目录 `vitest` CLI 驱动，即使各子包已安装 vitest，仍需 `pnpm add -D -w vitest` 在根 workspace 安装。

**Evidence**: `pnpm test` → `sh: vitest: command not found`；根级别安装后正常运行。

### [2026-05-01] Biome 1.9.4 使用 organizeImports 顶层键，非 assist
<!-- tags: biome, linting, config -->

**Scenario**: 沿用用户其他项目的 biome.json 配置，但 `assist.actions.source.organizeImports` 在 Biome 1.9.4 中报错 "Found an unknown key `assist`"。

**Lesson**: Biome 1.9.4 中 organizeImports 是顶层键 `"organizeImports": { "enabled": true }`，非 `assist` 下的嵌套配置。`assists` 键（带 s）在更新的版本中存在但功能不同。

**Evidence**: `biome check .` → `Found an unknown key assist. Known keys: $schema, extends, vcs, files, formatter, organizeImports, linter...`；修改后 lint 通过。

### [2026-05-02] BullMQ 重试配置在 Queue.defaultJobOptions 而非 Worker 构造函数
<!-- tags: bullmq, queue, worker, retry -->

**Scenario**: 实现 scan-storage 和 analyze-photo worker 时，需要在 BullMQ 中配置重试策略（attempts=3, exponential backoff）。

**Lesson**: BullMQ 的 attempts 和 backoff 参数通过 Queue 构造函数的 `defaultJobOptions` 设置，而非 Worker 构造函数。Worker 只接受 `connection`、`concurrency` 等运行参数。如果在 Worker 侧设置重试，不会生效。

**Evidence**: 
```typescript
// ✅ 正确：在 Queue 侧设置
const scanQueue = new Queue("scan:storage", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});

// Worker 侧不需要重试参数
new Worker("scan:storage", scanStorageWorker, { connection, concurrency: 1 });
```

### [2026-05-04] sharp 处理网络/SMB 挂载路径文件时先 readFile 读入 Buffer

<!-- tags: sharp, smb, network-path, seek-error, image-processing -->

**Scenario**: 缩略图生成和照片元数据提取使用 `sharp(filePath)` 直接从文件路径读取。当文件位于 SMB 网络挂载盘（如 macOS `/Volumes/` 挂载）时，sharp 内部触发 `bad seek` 错误导致处理失败。

**Lesson**: 对所有来自网络存储（SMB/NFS/WebDAV）的文件，先通过 `readFile(sourcePath)` 将完整文件读入内存 Buffer，再将 Buffer 传给 `sharp(buffer)`。这同样适用于 `sharp().metadata()` 调用——先 `readFile` 再 `sharp(buf).metadata()`。

**注意**: HEIC 转换路径已有独立的 `heicFileToJpeg` 函数（内部已使用 `readFile`），无需额外修改。视频处理走 ffmpeg，不受 sharp 影响。

**Evidence**: 生产环境 37 个文件触发 `Error: bad seek` 错误。修复后缩略图生成和元数据提取管线使用 Buffer 路径。参见 `thumbnail.ts:17` (`readFile` → `sharp(buffer)`) 和 `local.ts:260` (`fs.readFile` → `sharp(buf).metadata()`)。

### [2026-05-04] HEIC 文件可能伪装：扩展名 .heic 实际为 JPEG 内容

<!-- tags: heic, jpeg, content-detection, format-disguise, sharp, heic-decode -->

**Scenario**: 照片库中存在大量文件扩展名为 `.heic` 但实际内容为 JPEG（魔术数字 `ffd8ff`）。仅依赖扩展名选择解码器会导致 `heic-decode` 解码失败。

**Lesson**: HEIC 处理应采用双路径降级策略：
1. 主路径：`heic-decode({ buffer })` 尝试解码
2. fallback 路径：catch → `sharp(buffer)` 按内容自动检测格式

sharp 能从文件内容（而非扩展名）自动识别 JPEG/PNG/WebP 等真实格式，无需预先判断。

**Evidence**: 生产扫描日志中 294 个文件 `heic-decode` 失败。`file` 命令确认这些 `.heic` 文件实际为 "JPEG image data"。参见 `heic.ts:33-46` try/catch 降级实现。

**Scenario**: 实现照片管理页面的无限滚动时，需要在虚拟列表底部放置 sentinel 元素，用 IntersectionObserver 监听触发加载更多。

**Lesson**: sentinel 不能作为 useVirtualizer 的虚拟项渲染——因为当它不在可视范围内时虚拟滚动不会渲染它（永远不可见=永远不触发回调）。正确做法是 sentinel 放在虚拟容器内部、所有虚拟行之后，通过绝对定位（transform: translateY(totalSize)）固定在列表末尾。另一方案是为 sentinel 额外增加一个计数槽位（count + 1），用虚拟化渲染它。

**Evidence**: 初次实现时 sentinel 始终不可见、无限加载不触发。修改后 sentinelRef 附加到 index >= flatItems.length 的 slot（count + 1），IntersectionObserver 正常回调。参见 `use-virtual-grid.ts` 第 116 行 `count: flatItems.length + (hasMore ? 1 : 0)` 和第 143-163 行 sentinel 渲染逻辑。

### [2026-05-04] Sharp EXIF Buffer 格式兼容 + 轻量 TIFF 解析器
<!-- tags: sharp, exif, tiff, metadata, image-processing -->

**Scenario**: 从照片 EXIF 提取拍摄时间（DateTimeOriginal），使用已有的 sharp 依赖获取 EXIF Buffer，但 sharp 不解析 EXIF 字段值，只返回原始 Buffer。

**Lesson**: Sharp `metadata().exif` 返回的 Buffer 有两种格式：
1. 纯 TIFF 格式 — Byte order marker (II/MM) 在 offset 0
2. APP1 包装格式 — "Exif\0\0" 前缀在 offset 0-5，TIFF 从 offset 6 开始

编写轻量 TIFF 解析器（~60 行）即可提取 tag 0x9003，无需引入第三方 EXIF 库（增加 ~500KB）。解析器需处理：
- 双字节序（little-endian "II" / big-endian "MM"）
- 12 字节固定 IFD 条目
- inline value（≤4 bytes）vs offset value（>4 bytes）
- ASCII 字符串 null terminator 裁剪

**Evidence**: `storage/local.ts:28-96` 的 `findTiffStart()` + `parseExifDateTimeOriginal()`，兼容 Sharp 创建的测试 JPEG（无 EXIF prefix，纯 TIFF 从 offset 0 开始）。全部 25 个 storage adapter 测试和 21 个 scan-storage 测试通过。
