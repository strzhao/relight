# /photos 页面用户体验审计报告

**调查日期**: 2026-05-05  
**调查范围**: `http://localhost:3001/photos`（拾光照片库页面）  
**调查人**: autopilot 蓝队

---

## 总结

对 `/photos` 页面进行了全面用户体验审计，结合代码审查、curl 实测 API、sqlite 直查数据库、前端源码阅读，共发现 **23 个问题**，分布如下：

| 严重度 | 数量 | 问题类型 |
|--------|------|----------|
| P0 | 3 | 核心功能破损（数据缺失/错误无提示） |
| P1 | 9 | 显著影响体验（骨架屏/加载/无障碍） |
| P2 | 11 | 细节优化（URL 状态/性能/高级功能） |

**核心矛盾**：库内 6177 张照片（调查时），**5734 张（92.8%）`taken_at` 为 NULL**，导致年/月/日分组视图全部归入"未知时间"，核心导航功能形同虚设。这不是代码 bug，而是历史遗留数据——`storage/local.ts` 已有 EXIF→mtime fallback，但增量扫描跳过已存在照片，导致旧照片从未走过 fallback 路径。

**本次修复 4 项（P0×2 + P1×2），其余 19 项列入后续 task。**

---

## 23 条问题完整清单

### P0 — 核心功能破损（3 条）

**#1 ✅ takenAt 历史数据大规模为空（已修复）**  
- 严重度: P0  
- 文件: `apps/backend/src/storage/local.ts:181-185`，`apps/backend/src/workers/scan-storage.ts`（增量扫描逻辑）  
- 用户感受: 照片库按年/月/日分组时，92.8% 的照片落入"未知时间"分组，时间线导航完全失效。用户无法找到"2023 年拍的照片"。  
- 修复方向: 一次性 SQL backfill：`UPDATE photos SET taken_at = datetime(file_mtime, 'unixepoch') WHERE taken_at IS NULL AND file_mtime IS NOT NULL`（已执行，5734 行修复）  

**#2 ✅ 加载失败静默，无重试入口（已修复）**  
- 严重度: P0  
- 文件: `apps/web/app/photos/page.tsx:250-254`  
- 用户感受: 网络中断或后端宕机时，无限滚动到分页边界时加载失败，页面静默显示"上滑加载更多"——用户不知道出错了，反复上滑也无济于事，最终放弃。  
- 修复方向: sentinel 区域三态渲染：error → 红色重试按钮 / loading → spinner / idle → 空（已实施）  

**#3 筛选 UI 完全缺失**  
- 严重度: P0  
- 文件: `apps/web/app/photos/page.tsx`（无筛选组件）；后端 `/api/photos` 已支持 `tags[]` 参数  
- 用户感受: 无法按标签（"人像"/"风景"/"街拍"）过滤，6000+ 张照片无法缩小范围，浏览体验极差。  
- 修复方向: 顶部工具栏加 TagFilter 下拉组件，URL query `?tags[]=xxx` 驱动 API 请求，状态与 `usePhotosInfinite` hook 联动。后续 task。  

---

### P1 — 显著影响体验（9 条）

**#4 ✅ 骨架屏列数写死，SSR/CSR 不一致导致 hydration mismatch（已修复）**  
- 严重度: P1  
- 文件: `apps/web/app/photos/page.tsx:123-129`  
- 用户感受: 宽屏用户（1440px+）看到 3 列骨架屏闪变为 7 列真实网格，视觉跳变明显。控制台可能出现 React hydration warning。  
- 修复方向: 加 `mounted` state 防 SSR mismatch；mounted 后用 `style.gridTemplateColumns: repeat(${columnCount}, 1fr)`，块数 `columnCount * 4`（已实施）  

**#5 ✅ PhotoCard 失败态仅一个图标，无文字提示（已修复）**  
- 严重度: P1  
- 文件: `apps/web/components/photo-card.tsx:85-88`  
- 用户感受: 缩略图加载失败时，仅显示一个 `ImageOff` 图标，没有任何文字说明。屏幕阅读器无法描述。  
- 修复方向: 图标下加"加载失败"文字 + `aria-label="缩略图加载失败"`（已实施）  

**#6 ✅ img alt 属性为空字符串（已修复）**  
- 严重度: P1  
- 文件: `apps/web/components/photo-card.tsx:80`  
- 用户感受: 屏幕阅读器（VoiceOver / NVDA）对所有照片播报为"图像"或"空"，视障用户无法区分任何照片。  
- 修复方向: `alt={photo.filePath.split("/").pop() ?? photo.id}` 使用文件名作为 fallback（已实施）  

**#7 ✅ sentinel idle 态显示"上滑加载更多"（已修复）**  
- 严重度: P1  
- 文件: `apps/web/app/photos/page.tsx:251-253`  
- 用户感受: 当前已加载全部数据但 `hasMore=true` 的短暂间隙，页面底部持续显示"上滑加载更多"，误导用户认为还有内容，实际上什么都不发生。  
- 修复方向: idle 状态返回 null，不显示任何文案（已实施，作为修复 2 的一部分）  

**#8 Lightbox 键盘焦点管理缺失**  
- 严重度: P1  
- 文件: `apps/web/components/ui/lightbox.tsx`  
- 用户感受: 打开 Lightbox 后，Tab 键焦点仍在背景网格中游走，键盘用户无法操作关闭按钮和左右翻页。  
- 修复方向: Lightbox 打开时 `focus()` 到关闭按钮，`onKeyDown` 捕获 Escape/←/→，关闭时焦点归还触发元素。后续 task。  

**#9 缩略图无 HTTP 缓存头**  
- 严重度: P1  
- 文件: `apps/backend/src/routes/photos.ts`（thumbnail 路由）  
- 用户感受: 每次滚动回之前的照片，缩略图重新请求和解码，画面频繁白闪，流量浪费。  
- 修复方向: 缩略图响应加 `Cache-Control: public, max-age=31536000, immutable`（照片 id 不变则缩略图不变）。后续 task。  

**#10 原图返回 404/500 时 Lightbox 无错误状态**  
- 严重度: P1  
- 文件: `apps/web/components/ui/lightbox.tsx`  
- 用户感受: 点击大图查看，若原图文件已删除，`<img>` 静默失败，用户看到空白区域，不知道是加载中还是出错了。  
- 修复方向: Lightbox img 加 `onError` 回调，展示"原图加载失败"提示。后续 task。  

**#11 首屏 LCP 慢（未预加载前几张缩略图）**  
- 严重度: P1  
- 文件: `apps/web/app/photos/page.tsx:230`  
- 用户感受: 首屏照片加载慢，特别是首张大图。LCP 指标差。  
- 修复方向: 虚拟器第一行照片加 `<link rel="preload" as="image">` 或设置 `priority={true}` 更大的预加载范围。后续 task。  

**#12 无总数指示，用户不知道库里有多少照片**  
- 严重度: P1  
- 文件: `apps/web/app/photos/page.tsx`；后端 `/api/photos` 响应含 `total` 字段  
- 用户感受: 进入照片库，看不到"共 6177 张"的总数提示，无法感知库的规模。"已加载全部 X 张"仅在滚动到底才显示。  
- 修复方向: 顶部工具栏标题旁加 `(${total})` 或副标题，`total` 从 API 首页响应获取。后续 task。  

---

### P2 — 细节优化（11 条）

**#13 扫描时 thumbnail 写两次（冗余 IO）**  
- 严重度: P2  
- 文件: `apps/backend/src/workers/scan-storage.ts`  
- 用户感受: 扫描速度慢，磁盘写入频繁。（用户无直接感知，但影响扫描吞吐量）  
- 修复方向: 审查 scan worker 中 `generateThumbnail` 是否被调用两次，去掉冗余调用。后续 task。  

**#14 切换年/月/日视图时没有 scroll-to-top**  
- 严重度: P2  
- 文件: `apps/web/app/photos/page.tsx:92-97`  
- 用户感受: 滚动到中间后切换视图模式，分组标题变了但滚动位置不变，看到的是上一个视图的中间位置，需要手动滚回顶部。  
- 修复方向: `handleViewModeChange` 里调 `containerRef.current?.scrollTo(0, 0)`（实际已有此逻辑，但 virtualizer 未 reset，需检查）。后续 task。  

**#15 筛选/排序状态不在 URL 中**  
- 严重度: P2  
- 文件: `apps/web/app/photos/page.tsx`  
- 用户感受: 分享"按月视图、过滤了人像标签"的链接给他人，对方打开看到的是默认状态。  
- 修复方向: 用 `useSearchParams` 将 `dateViewMode`、`tags` 等状态写入 URL query。后续 task。  

**#16 loadMore 错误没有指数退避**  
- 严重度: P2  
- 文件: `apps/web/hooks/use-photos-infinite.ts`  
- 用户感受: 网络抖动时，自动重试频繁打后端，可能放大故障。  
- 修复方向: 失败后等待 2^n 秒再允许触发。后续 task。  

**#17 PhotoCard `onKeyDown` 不支持 Space 键跳出 Page**  
- 严重度: P2  
- 文件: `apps/web/components/photo-card.tsx:66-75`  
- 用户感受: 键盘浏览时按 Space 键，在 `role="button"` 卡片上会触发卡片点击，但也会触发页面滚动，行为冲突。  
- 修复方向: `e.preventDefault()` 已存在，但需确认 Space 不同时触发页面滚动。后续 task。  

**#18 a11y: 照片网格无 `role="grid"` 或 `role="list"` 语义**  
- 严重度: P2  
- 文件: `apps/web/app/photos/page.tsx:226-234`  
- 用户感受: 屏幕阅读器把照片网格读成一堆按钮，无法感知"这是一个 N 列 M 行的图片网格"。  
- 修复方向: 网格 div 加 `role="list"`，PhotoCard wrapper 加 `role="listitem"`。后续 task。  

**#19 无批量操作（选择/删除/导出）**  
- 严重度: P2  
- 文件: `apps/web/app/photos/page.tsx`（缺少该功能）  
- 用户感受: 无法多选照片进行批量删除或导出，必须一张一张操作。  
- 修复方向: 长按/Shift+Click 进入选择模式，底部 Action Bar 出现。后续 task。  

**#20 `/api/photos` 响应 `takenAt` 字段类型不一致**  
- 严重度: P2  
- 文件: `packages/shared/src/types.ts`；`apps/backend/src/routes/photos.ts`  
- 用户感受: `takenAt` 有时是字符串有时是 null，前端 `groupPhotos()` 必须防御式处理，增加代码复杂度。  
- 修复方向: Schema 明确 `takenAt: string | null`，API 返回统一格式。后续 task。  

**#21 虚拟列表中 N+1 个 IntersectionObserver**  
- 严重度: P2  
- 文件: `apps/web/components/photo-card.tsx:34-46`  
- 用户感受: 6000 张照片时创建 6000 个 IntersectionObserver 实例，首屏内存占用高，可能导致移动端卡顿。  
- 修复方向: 改用单一 `IntersectionObserver` 根实例，用 `WeakMap` 管理回调映射（或直接依赖虚拟列表的可见性，不在 PhotoCard 内部管理）。后续 task。  

**#22 移动端双指缩放手势未处理**  
- 严重度: P2  
- 文件: `apps/web/components/ui/lightbox.tsx`  
- 用户感受: 移动端在 Lightbox 中双指捏合/放大无效，体验明显不如系统相册。  
- 修复方向: 监听 `wheel`/`pinch` 事件实现 scale 变换。后续 task。  

**#23 Lightbox 无滑动切换手势**  
- 严重度: P2  
- 文件: `apps/web/components/ui/lightbox.tsx`  
- 用户感受: 移动端只能点击按钮切换上/下张，无法左右滑动，不符合手机用户习惯。  
- 修复方向: 监听 `touchstart`/`touchend` 计算 deltaX，超过阈值触发 prev/next。后续 task。  

---

## 本次修复汇总（4 项 ✅）

| 编号 | 标题 | 文件 | 状态 |
|------|------|------|------|
| #1 | takenAt 历史数据回填 | `apps/backend/src/cli/backfill-taken-at.ts`（新建）+ `package.json` | ✅ 已修复 |
| #2 | 加载失败重试按钮 | `apps/web/app/photos/page.tsx:sentinel 区域` | ✅ 已修复 |
| #4 | 骨架屏响应式列数 | `apps/web/app/photos/page.tsx:骨架屏分支` | ✅ 已修复 |
| #5/#6/#7 | PhotoCard 失败态文字 + alt + sentinel 文案 | `apps/web/components/photo-card.tsx` | ✅ 已修复 |

## 后续 Task（19 项）

以下问题已记录，优先级排序：

**P0（1项）**：#3 筛选 UI 缺失  
**P1（5项）**：#8 Lightbox 焦点、#9 缩略图缓存、#10 原图错误态、#11 首屏 LCP、#12 总数指示  
**P2（11项）**：#13–#23 所有细节优化  

---

## 关键运行实测数据

| 指标 | 数值 | 来源 |
|------|------|------|
| 照片总数 | 6177 张 | `sqlite3 relight.db "SELECT COUNT(*) FROM photos"` |
| 调查时 NULL takenAt | 5734 张（92.8%） | `SELECT COUNT(*) FROM photos WHERE taken_at IS NULL` |
| backfill 后 NULL takenAt | 0 张 | 同上（backfill 执行后验证） |
| 回填影响行数 | 5734 | `result.changes` |
| 幂等验证（二次执行） | 影响行数 = 0 | backfill 脚本二次运行 |
| `/api/photos?page=1&pageSize=5` 响应 | 包含 `total`, `photos[]`, `hasMore` | curl 实测 |
| 标签数量 | 不少于 50 个 | `SELECT COUNT(*) FROM tags` |

---

## 附录：调查方法论

1. **代码审查**：阅读 `apps/web/app/photos/page.tsx`、`apps/web/components/photo-card.tsx`、`apps/web/hooks/use-photos-infinite.ts`、`apps/web/hooks/use-virtual-grid.ts`、`apps/web/components/ui/lightbox.tsx` 全文，追踪数据流和状态机。

2. **API 实测**：使用 `curl http://localhost:3001/api/photos?page=1&pageSize=5 | jq` 查看真实 API 响应结构，验证 `takenAt` 字段。

3. **数据库直查**：使用 `sqlite3 apps/backend/data/relight.db` 查询关键统计指标，发现 takenAt NULL 问题的根因。

4. **后端代码审查**：阅读 `apps/backend/src/workers/scan-storage.ts`、`apps/backend/src/storage/local.ts`，理解增量扫描逻辑和 EXIF→mtime fallback 路径，确认历史数据遗留原因。

5. **plan-reviewer 红队审查**：设计方案经 plan-reviewer 审查，修正了 3 个 BLOCKER（Lightbox scroll 虚假 bug、datetime() 索引失效、shared types 缺失），形成 v2 方案。

6. **用户视角思维**：每个问题均从"用户实际操作场景"出发描述感受，而非单纯技术描述。
