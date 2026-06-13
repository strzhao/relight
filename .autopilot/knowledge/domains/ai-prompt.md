# AI 提示词与模型 (AI Prompts & Models)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-02] AI 分析质量验收采用纯规则自动化评分，非 AI 评估 AI

<!-- tags: ai, evaluation, testing, design -->

**Choice**: 5 维度纯规则自动化评分（格式合规/标签准确/描述相关/评分合理/覆盖完整），每维度 20 分满分 100。纯规则只能验证格式和结构合规性，无法评估语义质量。

---

### [2026-05-05] 每日精选采用两阶段 AI 流水线 — 文本评选 + 视觉叙事，最小化图片 token 成本

<!-- tags: ai, daily-selection, cost-optimization, two-stage-pipeline, architecture -->

**Choice**: 阶段 1 用文本模型比较候选照片已有 AI 分析结论选出胜者（零图片 token）；阶段 2 仅对胜者用视觉模型生成怀旧标题和文案（只发 1 张图片）。

---

### [2026-05-06] 视频 AI 分析采用多帧雪碧图 + Whisper 转录 + 视频专属 prompt

<!-- tags: video, ai-vision, whisper, sprite, ffmpeg, scene-cut, design, multi-modal -->

**Choice**: ffmpeg 抽 N=6 关键帧拼 3×2 雪碧图 + 抽音轨 16kHz mono → 调本地 Whisper CLI 转录 → 雪碧图 base64 + transcript 注入 v2/video prompt → 一次 vision 调用。失败降级用占位（`aiModel="video-failed:{kind}"`）。

---

### [2026-05-15] narrate prompt 软约束（recent_titles 占位 + 「避免重复标题」准则）

<!-- tags: daily-selection, narrate-prompt, title-deduplication, soft-constraint, recent-titles, query-recent-titles, ai-prompt-engineering, design -->

**Choice**: narrate prompt 软约束——`queryRecentTitles(30)` 扫描已用标题注入 user prompt，system prompt 加「避免重复标题」准则。并行 narrate 无法看到同批正在生成的 title，同日内偶发重复是已知限制。

---

### [2026-05-15] 撤销 narrate 命名人物注入：第二人称「你」呼告体优于硬塞具体称呼

<!-- tags: daily-selection, narrate-prompt, person-injection, second-person, product-tone, reversal, scope-control, ai-prompt-engineering -->

**Lesson**: AI prompt 的 system 规则 vs 风格示例冲突时，示例胜出。人称代词的相对性让 AI 反向解读。产品调性："你"呼告 = 亲密对话；具体称呼 = 第三方旁观。测试通过 ≠ 产品成功——端到端验证才暴露产品调性问题。

---

## 模式与教训

### [2026-05-05] qwen3 在 llama.cpp 上禁用思考模式必须用 chat_template_kwargs，thinking 字段是 vLLM 方言

<!-- tags: qwen3, llama-cpp, thinking-mode, openai-api, ai, performance, bug -->

**Lesson**: qwen3 系列在 llama.cpp 上禁用思考的唯一有效方式是 `chat_template_kwargs: { enable_thinking: false }`。`thinking: { type: "disabled" }` 是 vLLM/DashScope 方言，llama.cpp 完全忽略。

---

### [2026-05-15] narrate 第二人称"你"+ 画面人物注入：AI 仍偶尔把"你"映射到画面里的人

<!-- tags: ai, narrate-prompt, second-person, soft-constraint, prompt-engineering, daily-selection, bug -->

**Lesson**: prompt 工程中的"否定式约束 + 第二人称"是 LLM 最难遵守的组合之一。当前折衷：硬契约全通过，AI 偶尔行为偏离作为软约束 issue 不阻塞合并。

---

### [2026-05-06] 非 HEIC 图片在 AI 视觉分析前用 sharp 缩小尺寸减少 payload

<!-- tags: ai, vision, sharp, image-resize, performance, base64 -->

**Lesson**: 高分辨率照片全分辨率 base64 可达 12MB+，统一用 sharp 缩放到 2048px + JPEG quality 85，payload 降到 ~300KB。2048px 对美学评分、构图分析已足够。

---

### [2026-05-06] Whisper CLI 必须从 outputDir/<stem>.json 文件读，绝不解析 stdout

<!-- tags: whisper, cli, child-process, json, stdout, ai, transcribe, bug -->

**Lesson**: 这类 CLI 的设计是结果写文件，stdout 只是人类可读进度日志。真正的 JSON 在 `<outputDir>/<stem>.json`——等 `child_process.spawn` 的 close 事件 + `code === 0` 后再 `fs.readFile()` 读取。
