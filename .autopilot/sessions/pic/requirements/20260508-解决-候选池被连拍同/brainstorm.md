# Brainstorm — 连拍识别与去重

## 用户目标
- 在源头识别连拍（非仅 daily-selection 阶段过滤）
- 连拍组里只让最优的一张进入每日精选候选池
- /photos 页面把连拍合并展示，要一眼能识别为连拍
- 点击后能查看组内所有照片，并支持手动选择代表

## Q&A 结论

| 决策点 | 选择 | 备注 |
|--------|------|------|
| 连拍识别策略 | **时间窗口 + 感知哈希双重确认** | 同存储源 + takenAt 相邻 ≤ 3s 先聚类，再用缩略图 dHash 64-bit 校验汉明距离 ≤ 10。把"连续按了快门但场景切换"的伪连拍剔除 |
| 数据模型 | **新增 bursts 表 + photos.burst_id 外键** | bursts: id / representativePhotoId / memberCount / manualOverride / createdAt。photos 增加 burstId(nullable) + isBurstRepresentative(bool) |
| /photos 卡片 UI | **层叠纸片 + 角标计数** | ::before/::after 两层 4-6px 偏移阴影，右上角小徽章 `◫ N` |
| 代表照片机制 | **AI 后自动选 aestheticScore 最高 + 用户可手动覆盖** | 扫描时先用文件大小最大者作初始代表；AI 分析完批量自动校准（只在 manualOverride=false 时校准）；用户在抽屉里"设为代表"会置 manualOverride=true |

## 编排器自决细节（待用户审批确认）

- **时间窗口阈值**: 3 秒（行业经验：iPhone 连拍约 10fps，3s 内连续帧极大概率是连拍；间隔 >3s 通常已是新构图）
- **pHash 算法**: dHash 8×8（64-bit），从已生成的缩略图算（无需重读原图，CPU 开销极低）
- **pHash 汉明距离阈值**: ≤ 10/64（业界经验：相同场景一般 ≤ 8，留 2 bit 余量给压缩噪声）
- **检测时机**: scan-storage 在 photos 批量插入 + 缩略图生成完毕后追加一步 `detectBursts()`
- **AI 分析范围**: 所有连拍成员仍走 AI 分析（不省 token），保证用户切换代表时立即有 aestheticScore 数据；候选池过滤在 daily-selection SQL 完成
- **展开 UI**: 底部 Sheet（Radix UI Sheet/Drawer）展示组内全部成员，每张右上角"设为代表"按钮 + 当前代表角标
- **历史数据回填**: 一次性 CLI 脚本 `pnpm --filter @relight/backend tsx src/cli/detect-bursts.ts`，全量扫描已有 photos 聚类回填

## 范围控制
- **不做**: 跨存储源连拍合并、视频文件连拍识别、用户手动合并/拆分组、AI 评分外的代表评估维度
- **做**: 单存储源内同设备 3s 内时间窗口 + pHash 双确认；自动代表选择 + 手动覆盖；优雅卡片 UI；展开抽屉；CLI 回填
