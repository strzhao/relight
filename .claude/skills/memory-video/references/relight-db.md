# relight DB schema + 关键查询

DB: `relight/apps/backend/data/relight.db`（SQLite，WAL 模式，查询用 readonly）

## 关键表（snake_case）

### photos
id, storage_source_id, file_path, thumbnail_path(相对 `photos/thumbnails/<uuid>.jpg`), taken_at(ISO), media_type('image'/'video'), width, height, latitude, longitude, burst_id, is_burst_representative, phash, camera_make/model

### photo_analyses
photo_id, narrative(长文案), aesthetic_score(0-10), tags(json), composition(json: type/score/description), color_analysis(json: palette/dominant/mood), emotional_analysis(json: primary/secondary/intensity)

### faces
photo_id, person_id, bbox, embedding(**base64 512维 float32**), detection_score

### persons
id, name, centroid_embedding(base64), member_count

### photo_tags + tags
photo_id, tag_id, confidence；tags: id, name（中文，如「夜景」「人像摄影」「建筑」）

### bursts
连拍组：id, representative_id, member_count

## 人脸 embedding（人物主题必备）

embedding 存为 **base64 字符串**（512 维 float32 → 2048 字节 → base64 2732 字符）：
```js
const Database = require("better-sqlite3");
const db = new Database(DB, { readonly: true });
function toVec(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const raw = Buffer.from(b.toString("utf8"), "base64");  // 关键：base64 解码
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
function cosSim(a, c) { /* dot/(|a||c|) */ }
```

**踩坑**：直接当裸 float32 解析全成噪声（cos≈0）。必须 base64 解码。

**cos 只用来排序，不用来过滤**——它告诉你先看哪张，不告诉你这簇是不是一个人。这个库里母女/姐妹相似脸落在 0.5-0.7 是常态，遮挡（墨镜/口罩/侧脸/小脸）会让 embedding 饱和到 0.8+，石像与海报也能自聚成簇。**判断这个人是谁、是不是同一个人，靠把照片摊开看**（见 person-growth 的核验素材包）。

**婴儿期识别衰减**：赵合一 2019-2021（1-2岁）cos<0.4（centroid 被近期照片主导）。这类照片照样能用——靠画面语境判断，不靠 cos 证明。

## 选片查询模板

### 旅行单次聚类（region + 时间间隔≤5天）
```sql
-- 1. GPS 排除日常圈（包邮区 lat 27.5-31.5 lng 118-122.5）
-- 2. 同 region 内按 taken_at 排序，间隔>5天切分旅行段
-- 3. 每段去 burst（留 representative）+ 场景分桶 top
```

### 场景分桶选片（覆盖全貌）
桶定义（标签）：夜景 / 桥梁·几何 / 建筑 / 人像（单人肖像/人像摄影/女性）/ 街景（城市街景/街头摄影）/ 氛围（纪实/日常/怀旧/宁静）。每桶美学 top 4，去连拍。

### 人物成长线
faces.person_id=X + 去连拍 + 按年（孩子）或人生阶段（成人）选片（cos 当排序器）。出片前先摊开看，完整流程见 memory-video skill 的 `references/person-growth.md`。

命名人物清单（persons 表）：
```sql
SELECT id, name, member_count FROM persons WHERE name IS NOT NULL AND name != '' ORDER BY member_count DESC;
```
当前：赵合一(1322) / 翁雪珂(870) / 赵桂雄(144) / 王语晨(142) / 徐群仙(137) / 赵锡根(93) / 赵狄苏(27)。

### 情感主题
emotional_analysis.primary ∈ {平静, 宁静, 快乐, 温馨}（JSON LIKE 匹配）。

## 通用原则
- 去连拍：每 burst 留 is_burst_representative=1（或最高分）
- 缩略图 existsSync 过滤（db 有记录但 jpg 可能缺失）—— 仅 dry-run 选片占位；**正式渲染用原图**（见下「原图访问」）
- 美学 + 场景多样性双维度（不只美学 top）
- 地名优先 AI narrative 视觉识别（GPS 区间会判错，如重庆/贵州边界）

工具脚本：人物簇核验用本 skill 自带的 `scripts/person-contact-sheet.cjs`（摊开看图，见 person-growth）；选片/聚类在 video-dryrun：`select-cq.cjs`（旅行选片）、`select-person-growth.cjs`（人物选片）、`recall-trips.cjs`（旅行聚类）。

## 原图访问（1080p 正式版必须，不可降级）

**渲染素材必须用原图，不是 800px 缩略图**——1080p 下缩略图必糊。

- 原图路径 = `photos.file_path`，是**绝对路径**（如 `/Users/stringzhao/nas-photos/历史照片/DCIM/112APPLE/IMG_xxxx.HEIC`），**不是相对 STORAGE_ROOT**
- 原图多为 **HEIC**（iPhone 拍），Remotion/浏览器渲染不了，须转 JPEG：
  ```bash
  sips -s format jpeg -Z 1920 "<原图.HEIC>" --out "public/themes/<topic>/NN.jpg"
  ```
  macOS 自带 sips（无依赖）。-Z 1920 保证 1080p 横屏短边≥1080 清晰（实测 893KB HEIC→675KB JPEG）。JPEG 原图（非 HEIC）同样可用此命令拷贝/转码。
- **原图缺失（`existsSync(file_path)===false`）→ hard fail**：打印缺失路径、停止流程，**绝不降级用缩略图顶替**。NAS 软链（`nas-photos → /Volumes/stringzhao_主空间/我的备份`）漂移时原图全读不到，须先修软链再重跑（见 memory: nas-photos-smb-symlink-drift）。
- 800px 缩略图（`photos/thumbnails/<uuid>.jpg`）仅用于 dry-run 快速预览、选片 existsSync 占位，**不进正式渲染**。
