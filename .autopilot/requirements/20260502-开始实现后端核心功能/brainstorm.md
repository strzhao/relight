# 需求探索 Q&A

## 模型能力

**Q**: qwen3.6-35b 是否支持多模态？
**A**: 已确认支持。llama-server 启动时加载了 `mmproj-F16.gguf` 多模态投影仪，可接受图片输入。

## 分析维度

**Q**: AI 分析应输出哪些维度？
**A**: 全维度深度分析 — 标签(含置信度)、叙事描述(100-200字)、美学评分(1-10)、构图分析、色彩分析、情感分析、建议用途。

## 验收方式

**Q**: 如何量化验收 AI 分析质量？
**A**: AI 评分机制，在当前任务内设计评分 rubric 并执行验收，无需额外产品功能。核心思路：设计多维评分标准 → 用另一 AI 模型盲评分析结果 → 人工抽检校准。

## 增量策略

**Q**: 如何判断照片是否已分析？
**A**: 基于 fileHash (SHA256) 去重。扫描时计算文件哈希，与 DB 中已有记录对比，仅分析新增/变更的照片。

## 架构方案

**Q**: 选择哪种架构？
**A**: 方案A — BullMQ Worker 管线。scan-storage worker 扫描目录 → 去重 → 写入 photos → 触发 analyze-photo worker → base64 编码 → 调 aiClient.analyzePhoto → 解析 JSON → 写入 tags/photoTags/photoAnalyses。
