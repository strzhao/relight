# 图片处理 (Image Processing)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-04] DNG/RAW 使用 dcraw -e 提取嵌入 JPEG 预览而非 RAW 冲印

<!-- tags: raw, dng, dcraw, ai-vision, image-processing, design -->

**Choice**: 使用 `dcraw -e -c` 提取相机内嵌的 JPEG 预览。相机内嵌预览已是制造商精心处理的结果，质量足够 AI 分析。

---

### [2026-05-04] EXIF 解析选择轻量自研 TIFF 解析器，非第三方库

<!-- tags: exif, tiff, sharp, dependencies, design -->

**Choice**: 编写 ~60 行轻量 TIFF 解析器，直接解析 Sharp 返回的 EXIF Buffer，零额外依赖。仅支持 ASCII 字符串 tag（type=2），当前够用。

---

### [2026-05-11] photos 表加 GPS+EXIF meta 14 列 + cluster GPS 谓词 + narrate prompt 注入坐标

<!-- tags: gps, exif, exifr, schema-migration, cluster, union-find, daily-selection, narrate-prompt, location-awareness, ai-vision, geographical-context -->

**Choice**: 引入 exifr 库替换手写 TIFF 解析。强制 `reviveValues: false` 防 Date 对象进 SQLite 变 `[object Object]`。GPS 注入比 reverse geocode 工程价值高——现代 LLM 能直接从经纬度识别地标。

---

## 模式与教训

### [2026-05-04] sharp 处理网络/SMB 挂载路径文件时先 readFile 读入 Buffer

<!-- tags: sharp, smb, network-path, seek-error, image-processing -->

**Lesson**: 对所有来自网络存储的文件，先 `readFile` 将完整文件读入内存 Buffer，再将 Buffer 传给 `sharp(buffer)`。同样适用于 `sharp().metadata()` 调用。

---

### [2026-05-04] HEIC 文件可能伪装：扩展名 .heic 实际为 JPEG 内容

<!-- tags: heic, jpeg, content-detection, format-disguise, sharp, heic-decode -->

**Lesson**: HEIC 处理应采用双路径降级策略：主路径 heic-decode 尝试解码 → catch 后 sharp 按内容自动检测格式。

---

### [2026-05-05] HEIC 检测必须在 sharp resize 之前执行——sharp 预编译 libvips 不含 HEIC 解码

<!-- tags: heic, sharp, image-processing, code-order, bug -->

**Lesson**: 必须在任何 sharp 调用之前检查文件扩展名。HEIC 走 heicFileToJpeg() 路径，非 HEIC 走 sharp().resize() 路径。两者互斥，不可先后执行。

---

### [2026-05-05] sharp resize 必须显式 withoutEnlargement: true，否则小图被放大反优化

<!-- tags: sharp, image-resize, withoutEnlargement, ai-payload, code-quality, bug -->

**Lesson**: sharp resize 用作 payload 收紧时，所有路径必须带 `withoutEnlargement: true`。代码审查时把所有 `.resize()` 调用一起 grep 比对参数对齐。

---

### [2026-05-11] exifr 默认 reviveValues:true 会把 EXIF 日期转 Date 对象——存 SQLite TEXT 列变 `[object Object]`

<!-- tags: exifr, exif, sqlite, date-revive, reviveValues, translateValues, type-coercion, datetime-original, bug, library-default -->

**Fix**: `exifr.parse(file, { reviveValues: false, translateValues: false })`。用社区 EXIF 库时必须检查日期/数字字段的 revive 行为。

---

### [2026-06-13] 新增图片处理路径必须同步 RAW/DNG 支持

<!-- tags: raw, dng, dcraw, daily-selection, analyze-photo, image-processing, format-gap, bug -->

**Lesson**: 新增图片处理路径时，必须对照已有路径的格式分支清单逐一覆盖；将格式专用处理函数提取到共享模块强制复用，避免每个路径各自实现导致格式覆盖缺口。

---

### [2026-05-08] Satori 不保留 CSS `object-fit` 字面属性，必须用几何断言验证 contain/cover

<!-- tags: satori, svg, object-fit, server-side-rendering, geometric-assertion, wallpaper, image-composition, test, design -->

**Lesson**: Satori 把 CSS `object-fit` 翻译成几何：直接计算 `<image>` 的 x/y/width/height 属性。测试策略要从"prop 字面"切到"渲染行为不变量"。

---

### [2026-05-08] Satori 的 `jsxImportSource` 子路径必须精确到子包根

<!-- tags: satori, jsx, jsx-runtime, esm, typescript, jsximportsource, bug -->

**Lesson**: ESM 解析 `jsxImportSource` 时会自动拼 `/jsx-runtime` 后缀。satori 把 jsx 入口放在子包 `satori/jsx`，正确写法 `jsxImportSource: "satori/jsx"`。

---

### [2026-05-08] tsup 打包后 ESM `import.meta.url` 相对路径基准在 dev/prod 不同步

<!-- tags: esm, import-meta-url, tsup, dev-vs-prod, asset-path, build, bug -->

**Fix**: 检测 `import.meta.url.includes("/dist/")` 决定使用哪一段相对路径。单元测试常因只跑 tsx 路径而漏掉这类问题，必须在 prod build 后做一次 smoke。

---

### [2026-06-13] 壁纸维度缓存与 composedImagePath 的"双缓存"陷阱

<!-- tags: wallpaper, cache, daily-composed, dimension-cache, composedImagePath, invalidation, bug -->

**Lesson**: 缓存失效必须考虑所有 cache key 变体。当缓存按维度/参数派生不同 key 时，invalidate 操作必须删除该 pickDate 的所有缓存文件（`pickDate_*` glob）。
