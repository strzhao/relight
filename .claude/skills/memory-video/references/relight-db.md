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

## 人脸 cos 过滤（人物主题必备）

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
// face vs person centroid，cos≥0.5 = 高置信度
```

**踩坑**：直接当裸 float32 解析全成噪声（cos≈0）。必须 base64 解码。

**婴儿期识别衰减**：赵合一 2019-2021（1-2岁）cos<0.4 全误识别（centroid 被近期照片主导）。人物成长线处理：婴儿期跳过或视觉补救。

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
faces.person_id=X + cos≥0.5 + 去连拍 + 按年（孩子）或人生阶段（成人）选片。完整流程 + 2 个已验证案例见 memory-video skill 的 `references/person-growth.md`。

命名人物清单（persons 表）：
```sql
SELECT id, name, member_count FROM persons WHERE name IS NOT NULL AND name != '' ORDER BY member_count DESC;
```
当前：赵合一(1310) / 翁雪珂(867) / 王语晨(142) / 赵桂雄(142) / 徐群仙(137) / 赵锡根(92) / 赵狄苏(27，名字有 `^P` 脏字符待清洗)。

### 情感主题
emotional_analysis.primary ∈ {平静, 宁静, 快乐, 温馨}（JSON LIKE 匹配）。

## 通用原则
- 去连拍：每 burst 留 is_burst_representative=1（或最高分）
- 缩略图 existsSync 过滤（db 有记录但 jpg 可能缺失）—— 仅 dry-run 选片占位；**正式渲染用原图**（见下「原图访问」）
- 美学 + 场景多样性双维度（不只美学 top）
- 地名优先 AI narrative 视觉识别（GPS 区间会判错，如重庆/贵州边界）

工具脚本（video-dryrun）：`select-cq.cjs`（选片）、`recall-trips.cjs`（旅行聚类）、`analyze-faces.cjs`（人脸 cos）。

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
