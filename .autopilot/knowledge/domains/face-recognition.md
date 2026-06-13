# 人脸识别 (Face Recognition)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

## 架构决策

### [2026-05-12] 人脸识别选 ONNX Runtime + SCRFD-500M + ArcFace MBF 纯本地方案

<!-- tags: face-recognition, onnx, scrfd, arcface, local-inference, privacy, coreml, model-selection, design, architecture -->

**Choice**: 选 onnxruntime-node + SCRFD-500M + ArcFace MobileFaceNet，模型权重共 ~16MB。macOS 启用 CoreML EP。embedding 512 维 L2-normalized，base64 文本存 SQLite。聚类用增量 cosine threshold 0.5。

**设计偏离**: 原选 SCRFD-2.5G，但公开 ONNX 镜像实测无 2.5G 变体（buffalo_l 给 10G/174MB ResNet50 过重，buffalo_s 给 500M+MBF）。500M 对家庭相册足够。

---

### [2026-05-13] 人脸聚类引入 qwen 语义属性 + 临界硬过滤 + JSON 字段预留未来扩展

<!-- tags: face-recognition, face-clustering, qwen-vl, semantic-attributes, hybrid-clustering, cosine-threshold, json-schema, schema-version, future-proof, design, architecture -->

**Choice**: 复用现有 llama-server qwen-vl 为每张脸打 6 维语义属性（age_band/gender/hair/glasses/facial_hair/expression），存到 `faces.attributes` JSON 列。聚类改双阈值：cosine ≥ 0.7 直接合并、< 0.55 直接不合并、[0.55, 0.7) 临界区间用属性硬过滤。`schema_version: 1` 字段预留未来扩展。

---

### [2026-05-14] 单 centroid → Apple 多原型方案：每 person 1-5 个 sub-prototype + max(cosine) 匹配

<!-- tags: face-clustering, multi-prototype, exemplar, apple-photos, cross-age, cross-appearance, kmeans, arcface, centroid, design, architecture -->

**Choice**: 每 person 存 1-5 个 sub-prototype（K_MAX=5）代表不同"外观模式"。新表 `person_prototypes` 关系型。匹配规则改 `max over i of cosine(new, prototype_i)`。保留 persons.centroid_embedding 作粗筛索引。保留 quality-aware + attribute filter 三件套。

---

### [2026-05-15] self 标记用 settings.selfPersonId 单 key，不加 persons.isSelf 列

<!-- tags: settings, schema-design, single-value-pointer, isSelf, persons, design -->

**Choice**: settings 单 key（`selfPersonId`）。self 是全局单值指针，不是 person 本征属性。settings 单 key 天然唯一，无并发竞态。

---

## 模式与教训

### [2026-05-14] 人脸增量聚类的「centroid 雪球 + 垃圾桶 cluster」陷阱与三件套修复

<!-- tags: face-clustering, incremental-clustering, centroid-drift, quality-aware, snowball, garbage-cluster, embedding, arcface, bug, algorithm -->

**Lesson**: 增量聚类用 centroid 做赛马必然滚雪球——大 cluster 的 centroid 趋向"通用脸"，吸引力远超小 cluster。修复三件套：(1) quality 分级 HIGH/MED/LOW；(2) centroid 只让 HIGH/MED 拉动；(3) mergeThreshold 调到 0.85，让 [0.55, 0.85] 全区间走属性硬过滤。

---

### [2026-05-14] ArcFace MobileFaceNet 边缘正例 cosine 分布陷阱：聚类粗筛阈值不能凭"安全裕量"推理

<!-- tags: face-clustering, arcface, mobilefacenet, cosine-threshold, coarse-filter, embedding-distribution, prototype, recall, autopilot-verification, bug -->

**Lesson**: 粗筛阈值如果按"= 主合并阈值 - 安全裕量"推理设定，在 ArcFace MobileFaceNet 上会大量误剔同人正例。必须在真实 embedding 全量分布上验证。所有"距离/相似度类阈值"必须用真实数据校准，不能凭数学直觉。
