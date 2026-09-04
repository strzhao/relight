---
name: memory-video
description: 把一组照片生成「全屏沉浸 + 章节暗线叙事 + 霞鹜文楷字幕」的回忆/旅行/人物成长线短片（mp4，原图 1080p）。当用户要做照片视频、旅行短片、vlog、回忆视频、给一组照片配叙事出片、任意命名人物的成长线/人生弧线（relight persons 表里的人，如赵合一/翁雪珂）、或提到 relight 视频生成/每日视频/旅行短片/人物成长线时，务必使用本 skill。覆盖选片（去连拍+场景分桶+时间序 / 人物 cos≥0.5 过滤）、章节暗线叙事（LLM 提案章节+弧线字幕）、Remotion 渲染、html 预览全流程；可选音乐节拍匹配（缩放脉冲跟拍，苹果 Memories 效果）。
---

# 记忆视频生成（Memory Video）

把照片库的一组照片，生成一部**有叙事骨架**的短片：全屏沉浸 Ken Burns + 章节暗线（情绪弧线）+ 霞鹜文楷字幕 + 标题/收尾卡 + FreePD 配乐。

## 何时用

- 「把这次旅行的照片做成视频」「给一组照片配叙事出片」「做个 vlog/回忆短片」
- **人物成长线**：「给合一/翁雪珂/某人做个成长视频」「这些年的照片做成短片」——任意 relight 命名人物（persons 表），按年龄里程碑（孩子）或人生阶段（成人）出弧线
- relight 视频生成（旅行 / 人物成长线 / 情感主题）
- 任何「照片 → 叙事短片」的需求

## 三条铁律（必读，决定一切）

1. **故事核心 > 技巧**：不堆转场/滤镜，靠章节暗线 + 弧线字幕讲故事。视频"没灵魂"几乎都是叙事问题，不是特效问题。
2. **章节暗线 + 情绪递进**：用一条递进的线索把照片分章节（经典「四瓶酒」：拘谨→话多→爆发→平静），每章一个情绪节点。**这是与"平铺幻灯片"的本质区别。**
3. **尊重原图**：① 用户照片本身已风格化（胶片/滤镜是拍摄时定的），视频**不再盖 sepia/颗粒/色彩扭曲**，靠布局/排版/节奏/字体差异化；② **渲染素材必须用原图**（`photos.file_path`），不是 800px 缩略图——1080p 下缩略图必糊。原图缺失就 **hard fail 停止**，绝不降级用缩略图顶替（详见选片步骤）。

叙事原则详见 `references/narrative.md`（B 站 vlog 叙事调研沉淀）。

## 全流程

### 1. 选片
输入主题 → 查 relight DB → **去连拍**（每 burst 留代表）→ **场景分桶**（保证覆盖旅行全貌，不只美学 top）→ **时间序**排列 → 选 ~20-24 张。
- 旅行主题：GPS 聚类单次旅行（同区域 + 间隔≤5天），排除日常圈
- **人物主题（成长线）**：**人脸 cos≥0.5 过滤**（face embedding vs person centroid 余弦相似度）+ 去连拍 + 按年（孩子）或人生阶段（成人）选片。叙事骨架由 LLM 提案（孩子=年龄里程碑，成人=人生阶段）。详见 `references/person-growth.md`
- 关键：别只按美学选（会漏场景），要**场景多样性 + 美学**双维度
- **素材必须用原图（硬约束，不可降级）**：选出的每张，从 `photos.file_path`（**绝对路径**，如 `/Users/stringzhao/nas-photos/.../IMG_xxxx.HEIC`）取原图。原图多为 HEIC，Remotion/浏览器渲染不了，须转 JPEG：`sips -s format jpeg -Z 1920 "<原图>" --out "public/themes/<topic>/NN.jpg"`（macOS 自带 sips，无依赖；-Z 1920 保证 1080p 横屏短边≥1080 清晰）。**原图缺失（`existsSync(file_path)===false`）立刻 hard fail**——打印缺失路径、停止整个流程，**绝不降级用 800px 缩略图顶替**（缩略图 1080p 必糊，且降级会掩盖素材缺失问题）。DB 有 `thumbnail_path` 但原图不可用的照片，淘汰并报错。

### 2. 叙事（核心，LLM 提案）
读选片的 narrative → 提案：
- **章节划分**（~5 章，按内容/时间/情绪）
- **每章暗线**（一句情绪主题，如「山城的魔幻，在灯火里苏醒」）
- **每章 mood**（静/暖/动/烈）：驱动该章镜头的动画+切换效果池——效果服从叙事气质，避免「婚礼照配 Flip 翻转」这类全随机违和组合。映射：收尾/独处/宁静→静；温暖/相恋/日常→暖；热闹/旅行/探索→动；高潮/爆发/仪式→烈。弧线通常 静→暖→动→烈→静。详见 `references/narrative.md`「章节 mood」
- **弧线字幕**：每张字幕从"描述画面"→"推进情绪"。例：火锅镜不写"红油翻滚"，写"山城的第一口，是滚烫的烟火"；收尾不写"霓虹点亮天际"，写"三天走过，山城归于夜的宁静"。

数据契约见 `references/data-schema.md`。

### 3. 渲染（Remotion）
- 模板：**Immersive**（全屏 cover + 8 方向 Ken Burns + Easing.inOut 缓动 + 章节卡 + 标题/收尾卡 + 霞鹜文楷字幕）
- 字体：**霞鹜文楷 LXGW WenKai**（中文字幕，文艺楷体）+ Fraunces（英文标题）+ NotoSerifSC（章节卡/标题卡）
- 配乐：Kevin MacLeod CC-BY（[incompetech.com](https://incompetech.com/music/royalty-free/music.html)，mp3 直链 `https://incompetech.com/music/royalty-free/mp3-royaltyfree/<Name>.mp3`，**FreePD.com 已永久关闭 2008-2025**）；现有 night-venice/isolation-waltz/bgm 早年下自 FreePD。节拍匹配优先选**兼顾叙事+节拍**的曲子（轻爵士/民谣带轻鼓点），别为踩拍选违和的曲子（纯鼓配抒情叙事就违和），见 `references/beat-sync.md`
- 字幕样式：霞鹜文楷 38px，靠下（paddingBottom 5%），双层 textShadow，spring 弹性入场，**不加装饰线/不加滤镜**
- **素材方向自适应（必做，避免竖/方图被裁切）**：convert 时按方向预处理——横图（w>h）按脸预裁 16:9（A）；方图/竖图 contain + 预生成模糊背景（B）。Shot 横图 cover 居中 / 方竖图双 Img（模糊 bg + contain）。详见 `references/orientation.md`
- **渲染必须 `gl=angle`**：`renderMedia({ ..., concurrency: 4, chromiumOptions: { gl: "angle" } })`——默认 gl=null 软件渲染会崩溃卡死（见 orientation.md）。1080p ~36s
- **音乐节拍匹配（可选增强）**：缩放脉冲跟音乐节拍呼吸——**用户对 Ken Burns 缩放的感知 >> 瞬时切换**，所以节拍感来自缩放脉冲而非切换卡拍（切换每 4-5s 太稀疏，表达不了 ~0.5s 的密集节拍）。`analyze-audio.cjs`（onset 检测）→ `build-beatmap.cjs`（snap 对齐 + shotOnsets）→ Shot 叠加 zoom 脉冲。默认每镜 1 次 +1.2% 0.8s cos 钟形。详见 `references/beat-sync.md`
- **章节 mood 效果池（可选增强）**：按章节情绪（静/暖/动/烈）从 anim×trans 子池确定性随机选——效果服从叙事气质，避免全随机违和（如婚礼×Flip 翻转）。底层 `effects.ts`（10 anim×10 trans 全能力）+ 上层 mood 选池；Shot 三层 transform 嵌套（L3 enter 包 L1 pulse 包 L2 anim，绝不字符串拼接）。无 mood 自动回退原 8 方向 KBS+fade（老主题兼容）。详见 `references/effect-pools.md`
- 输出：**正式版必须 1080p（1920×1080）**——把 composition 的 width/height 设 1920×1080（Root.tsx 注册处，或 render 时 `composition: {...comp, width:1920, height:1080}` override）。720p（1280×720）仅 dry-run 快速预览。配 html 预览页。

Remotion 项目结构见 `references/remotion-setup.md`。

### 4. 预览 + 迭代
生成 html（每个视频独立 controls，逐个看），用户确认后迭代。**字幕/叙事/选片都可单独迭代，叙事优先。**

## 关键参数（已验证）

| 参数 | 值 | 说明 |
|------|-----|------|
| 每镜时长 | 旅行 BEATS_PER_SHOT=12（~6.4s）/ 人物成长线 16（~8.5s）| 旅行 vlog 节奏利落；人物抒情保留呼吸。原统一 16 拍对旅行偏长（8.5s 拖）→ 旅行缩 12。build-beatmap argv[5] 覆盖（默认 16）。非 beat-sync fallback SHOT=150（5s） |
| 首镜 | FIRST_SHOT=200 | 标志性镜头更多呼吸 |
| 章节卡 | CHAP_F=66（~2.2s）| 章节过渡 |
| 转场 | fade，FT=20 | @remotion/transitions，linearTiming |
| 总时长 | ~2 分钟（24 张 + 5 章卡）| 旅行短片合理区间 |
| 字幕字号 | 38（对齐结尾卡）| 霞鹜文楷 |
| 分辨率 | **正式 1920×1080** / dry-run 1280×720 | 正式版必须 1080p，720p 仅预览 |
| pulse + breathe 缩放 | **全关**（pulseScale=1）| pulse 跳动 + breathe 呼吸振荡（每 1.4s）用户都觉得"跳"→ 全去；Ken Burns 缩放纯 L2 anim 连续平滑 |
| mood 效果池 | 静/暖/动/烈 4 档子池 | 章节情绪驱动 anim×trans（见 effect-pools.md）；无 mood 回退 KBS+fade |
| 镜头 ft | max(trans.minFt, mood.defaultFt) | 静10/暖12/动13/烈13；无 mood=4。FT 放宽不削弱节拍（脉冲是来源）|
| 渲染速度 | 720p ~15s / 1080p ~40s | worker 无压力 |

## 踩坑备忘（务必避免）

- **Remotion composition id 禁下划线**：`StyleA-Magazine` 合法，`StyleA_Magazine` 报错
- **timing 函数是 `linearTiming`**（从 `@remotion/transitions` 主包导出），不是 `linear`
- **人脸 embedding 是 base64**：512 维 float32 → 2048 字节 → base64 2732 字符。读取须 `Buffer.from(b64,'base64')` 再 `Float32Array`，直接当裸 float32 解析全成噪声
- **原图是 HEIC 且为绝对路径**：`photos.file_path` 是**绝对路径**（如 `/Users/stringzhao/nas-photos/...`），不是相对 STORAGE_ROOT。Remotion 渲染不了 HEIC，须 `sips -s format jpeg -Z 1920` 转 JPEG（实测 893KB HEIC→675KB JPEG）。NAS 软链（nas-photos→/Volumes/...）会漂移，原图全读不到时须先修软链。
- **原图缺失 hard fail，绝不降级缩略图**：800px 缩略图在 1080p 下必糊，且用缩略图顶替会掩盖素材缺失。缺原图就停，报清楚哪张缺。
- **缩略图文件可能缺失**：db 有记录但 jpg 不在，召回须 `existsSync` 过滤（此条仅 dry-run 选片占位；正式渲染用原图，见上）
- **非交互落盘必须用 env 绝对路径**：后端 spawn 时把产物绝对路径同时通过环境变量传出（`OUTPUT_PATH` / `META_PATH` / `COVER_PATH`，均为绝对路径）+ prompt 文本。finalize/落盘脚本**必须直接读 `process.env.OUTPUT_PATH` 等**，禁止自己硬编码或从相对路径推断目录。**血泪教训**：曾有一次 claude 生成 `finalize-japan.cjs` 把 `DST_DIR` 硬编码成 `/Users/.../relight/photos/.video-cache`（仓库根 photos），而 daily-video job 检查的是 `apps/backend/photos/.video-cache`（STORAGE_ROOT）——mp4 渲染成功却被拷错目录，job 报「mp4 产物缺失」，叠加 discovery 的 failed 不去重，japan-2018 连挂 5 天、锁死整个出片名额。根因就是没用 env 给定的绝对路径。
- **地名别靠手写 GPS 区间**：东北/日本、贵州/重庆边界会判错。优先用 AI narrative 的视觉识别（认出洪崖洞=重庆），GPS 只辅助
- **sharp 必须加 `.rotate()`**：iPhone 照片有 EXIF orientation，不 rotate 会把竖图当横图（relight detect-faces.ts 也用 .rotate()）。HEIC 先 sips 转，再 sharp.rotate()
- **渲染必须 `gl=angle`**：Remotion 默认 gl=null（swiftshader 软件渲染）在长期未重启 / WindowServer 占 GPU 的机器**崩溃卡死**（重装 chrome 也救不回）。`chromiumOptions: { gl: "angle" }` 走 Metal GPU，1080p ~36s，**不用重启电脑**
- **mp4 必须 faststart**：Remotion 默认 moov atom 在文件尾部，大文件（>100MB）时 QuickTime 等播放器要读完全文件才能解析 → 卡住/播放失败。`render-immersive.mjs` 渲染后必须 `ffmpeg -movflags +faststart -c copy out.fs.mp4 && mv out.fs.mp4 out.mp4`（moov 移到开头，秒级不重编码）
- **不用运行时 objectPosition / CSS blur**：objectPosition 触发 Chrome CPU 慢路径（实测卡死），filter:blur 是性能毒药——都在 convert 阶段预裁切/预生成静态图，渲染走 GPU cover/contain
- **方图归 contain**：方图（w==h）cover 会切头/构图怪，必须和竖图一样走 contain 全部 + 模糊背景；只有严格横图（w>h）才 cover
- **beat-sync：时长 snap 保留，缩放 pulse 默认关**：pulse 跟 onset 跳动在旅行/风景 vlog 下违和（风景照不该"跳"），用户反馈去掉 → CQ-Immersive 默认 `pulseScale=breathe`（固定呼吸不跳）。**镜头边界时长 snap（shotFrames 读 beatmap）保留**（镜头跟音乐时长）。snap 对齐 > grid（grid 纯周期累积漂移）。人像抒情可选启用 pulse。详见 `references/beat-sync.md`
- **三层 transform 嵌套绝不字符串拼接**：beat 脉冲(scale)+anim(translate/rotate/skew)+trans.enter(clip/scale) 共存时，CSS transform 顺序敏感，拼接会让脉冲放大/扭曲 anim。必须 DOM 嵌套三层 div（L3 enter 包 L1 pulse 包 L2 anim）。详见 `references/effect-pools.md`
- **FT 放宽到 10-13 不削弱节拍感**：mood 池的 slide/wipe/iris 需 ≥12 帧才展开；节拍来源是缩放脉冲不是切换，FT 放宽无影响。无 mood 回退 FT=4
- **bodyFrames 用实际 transition ft 之和扣减**：动态 ft（mood 版）必须 `sumSeq - sum(ftOf)`，用固定 FT 扣会导致 composition 时长与 TransitionSeries 不匹配（渲染截断/留黑）

## 人物成长线（任意命名人物）

任意 relight 命名人物（persons 表）的成长/人生弧线短片。**叙事骨架由 LLM 按照片内容提案**（引擎不预设），两种已验证范式：
- **孩子 → 年龄里程碑**：稚嫩→好奇→欢腾→远行（合一 2022-2026，首尾「睁眼的小→远方的远」）
- **成人 → 人生阶段**：少女→相恋→新婚→孕育→为母（翁雪珂 2013-2026，首尾「独自远行→牵手看世界」）

**三个关键点**：
1. **cos≥0.5 过滤是地基**——用户指认的误识别全在 cos<0.4。用 `analyze-faces.cjs` 先查 cos 分布是否健康。
2. **婴儿期 gap（孩子主题）**：0-3 岁 cos 衰减（centroid 被近期照片主导），cos≥0.5 池可能真空。补救用 qwen vision 视觉二次确认，或跳过从 3 岁起。成人无此问题。
3. **跨视频去重（亲子照陷阱）**：一张亲子照母亲+孩子都识别，会同时进两人候选池。正式版建 `video_usages` 表排除已用照片；dry-run 手动避开。

选片脚本 `select-person-growth.cjs [person_id] [name]`（按年美学/场景多样）+ `convert-{name}.cjs`（原图转 1080p）。完整指引见 `references/person-growth.md`。

## 数据源

默认 relight DB（`apps/backend/data/relight.db`）：photos / photo_analyses（narrative, aesthetic_score, emotional_analysis, color_analysis）/ faces（embedding, person_id）/ photo_tags / tags / bursts / persons。schema + 查询见 `references/relight-db.md`。

## 产物位置参考

当前完整实现（重庆样例）在 `relight/.autopilot/runtime/requirements/20260725-每日视频生成/video-dryrun/`：Immersive 模板 + select-cq.cjs（旅行选片）+ select-person-growth.cjs（人物成长线选片，任意 person_id）+ recall-trips.cjs（旅行聚类）+ analyze-faces.cjs（人脸 cos 分布）+ convert-{name}.cjs（原图转 1080p）+ 字体 + 配乐。新主题换数据复用这套。

**已出片样例**（均在 `out/`）：CQ-Chongqing-1080p.mp4（旅行·24张）、CQ-Heji.mp4（合一年龄里程碑·17张）、CQ-Weng.mp4（翁雪珂人生阶段·16张）、CQ-Weng-Beat7.mp4（翁雪珂+缩放脉冲跟拍·节拍匹配验证）、CQ-Weng-Mood.mp4（翁雪珂+章节mood效果池·三层嵌套验证）、FX-MoodMix.mp4（mood池纯展示·3静3暖3动3烈）。

**节拍匹配脚本**（详见 `references/beat-sync.md`）：analyze-audio.cjs（onset 检测）/ build-beatmap.cjs（snap 对齐 + shotOnsets）/ diagnose-beat.cjs（自检偏差）/ gen-click.cjs（机械鼓点对照）。

**效果池模块**（详见 `references/effect-pools.md`）：`src/scenes/effects.ts`（ANIMS/TRANS 10×10 全能力 + MOOD_POOLS 4 档子池 + pickEffectsForChapter 确定性选 + kind/minFt 元数据）。CQ-Immersive 按 `chapter.mood` 从子池为章内镜头选 anim×trans；FX-Showcase 是全池 dry-run 挑选页。

## claude -p 非交互自动化模式

当 prompt 含「非交互自动化模式」（典型场景：relight 后端 `daily-video` job 通过 `claude -p <prompt>` spawn 本 skill）时，**跳过所有交互步骤，直出 1080p mp4**：

### 与交互模式的差异

| 步骤 | 交互模式 | 非交互自动化模式 |
|------|---------|----------------|
| html 预览 | 生成 preview.html 供用户确认 | **跳过**（不生成预览，不等待确认） |
| 选片 | 用户可能手动调整 photoId 列表 | **trip：从 prompt 素材池自主选最终片数（≥20，按旅行丰富度做完整 vlog，不限上限，别只取 top 也别全硬塞）**；person：personId+截止年走成长线选片 |
| 叙事/mood | 用户可微调章节 | **LLM 正常提案章节+弧线字幕**（无人工介入，一次出） |
| 渲染目标 | 可选 dry-run（720p 验证） | **直接 1080p**（`gl=angle`，`chromiumOptions: { gl: "angle" }`） |
| 产物落盘 | 交互式指定 | **mp4 + 元数据 json 写到后端给定绝对路径**（**直接用 `process.env.OUTPUT_PATH` / `META_PATH` / `COVER_PATH`**，禁止自己推断目录，见下「落盘路径契约」） |
| 失败处理 | 用户介入 | **非零退出，不降级**（原图缺失/渲染崩/字体缺都直接退出码≠0，后端写 failed 行） |

### prompt 契约（后端构造，skill 解析）

prompt 格式（固定 6 行）：
```
用 memory-video skill 生成视频，非交互自动化模式。
主题：<trip|person> / <themeKey>（<titleHint>）
素材：<trip=素材池 photoId 列表（按美学降序，AI 自主选 ≥20 做完整 vlog） | person=personId=xxx 截止年=YYYY>
产物：mp4 → <绝对路径>
      元数据 → <绝对路径>（title/durationSec/photoIds）
约束：直接出 1080p（不 dry-run 不预览）；原图缺失→非零退出（不降级缩略图）。
```

skill 须从 prompt 解析出：
- `themeKind` / `themeKey`：驱动选片策略（trip 走旅行选片 / person 走人物成长线选片）
- `photoIds`（trip）或 `personId`+`toYear`（person）：素材来源
- `outputPath` / `metaPath` / `coverPath`：**优先取 `process.env.OUTPUT_PATH` / `META_PATH` / `COVER_PATH`（后端 spawn 时注入的绝对路径）**，prompt 文本里的 `产物：mp4 → <path>` 仅作兜底。finalize/落盘脚本必须直接用这些 env 绝对路径，**禁止自己硬编码或从相对路径推断目录**（详见踩坑备忘「非交互落盘必须用 env 绝对路径」）。

### 元数据 json 格式（skill 写到 metaPath）

```json
{
  "title": "重庆 · 2021",
  "durationSec": 32.5,
  "photoIds": ["uuid1", "uuid2", "..."]
}
```

后端读取此 json 填充 `videos` 表（title/durationSec/photoIds 列）。json 缺失不视为失败（后端用 titleHint fallback）。

### 退出码语义

- **0**：成功，mp4 + json 已写到约定路径（后端读 exit code=0 后校验文件存在，写 completed 行 + 推送）
- **非 0**：失败（原图缺失 / 渲染崩 / 字体缺失 / Remotion 报错）。后端读 stderr 记 failed 行，**不重试渲染、不降级缩略图、不凑弱主题**。

### 关键复用点（非交互模式同样适用）

- 选片脚本：`select-cq.cjs`（旅行）/ `select-person-growth.cjs [person_id] [name]`（人物）—— 非交互模式传 prompt 解析的参数，不询问用户
- beatmap 生成（音乐节拍匹配）：`node build-beatmap.cjs beats-xxx.json "4,3,3,2,4" snap [beatsPerShot]`——旅行 themeKind=trip 传 12（~6.4s 利落），人物 person 不传（默认 16，~8.5s 抒情）。详见 `references/beat-sync.md`
- 渲染：`render-immersive.mjs`（已含 `gl=angle`，1080p）
- 原图转码：`convert-{name}.cjs`（HEIC/NAS 软链漂移处理不变）
- 原图 hard fail 不变：缺原图直接非零退出，不降级

> 此模式让后端 `daily-video` worker 可无人值守每日出片。质量优先：没主题/原图缺/渲染失败当天就不出片（绝不凑/不降级）。
