# VPS 画廊 + COS 推送（gallery.stringzhao.life）

<!-- tags: gallery, cos, vps, caddy, manifest, 推送式同步, 企微-webhook, 旁路容错 -->

## 企业微信群机器人 webhook 能力边界（不支持视频）

[2026-08-01] 企业微信群机器人 webhook 只支持 text / markdown / image（≤2MB base64）/ news（图文卡跳外链）/ file（需 upload_media，≤20MB）。**不支持 video 类型消息**（群机器人无 video msgtype；「应用消息」API 才有，也要 media_id 且文件受限）。

- **Lesson**：vlog ~119MB 超 file 通道 20MB 上限，群机器人没有 video msgtype。视频只能靠**公网 URL**让群里点开播放。
- **Choice**：每日视频推送不发视频本体，发封面（image）+ 标题 + **公网播放链接**（`gallery.stringzhao.life/#/video/<id>`）。企微硬限制，非代码问题。关联 [[video]]（每日视频自动化推送）。

## VPS 公网画廊推送式架构（复用现有基建，零新容器）

[2026-08-01] 数据在本机 SQLite（dailyPicks/videos），VPS 拿不到 → 用**推送式同步**：本机 daily-selection / daily-video job 完成后，资源传 COS、manifest.json 推 VPS（ssh scp），VPS Caddy 静态站读 manifest 渲染。

- **Lesson**：VPS 纯静态无后端无 DB，本机主动 push（非 pull）。复用 vps-ops 全部现有基建（公有读 COS 桶 `little-bee-assets` + Caddy 反代 + 备案域名 `stringzhao.life` + SSH 免密 + 子账号 AK/SK），**零新增基础设施**。
- **Choice**：Caddy 加一个 server block 托管静态 HTML（root + file_server + `X-Robots-Tag noindex`），零新容器（VPS 内存紧 1.9G 跑 5 容器）。manifest 全量重生成（数据小 ~458 entries 级，无增量状态机）。资源走 COS 公有读直链，key=photoId UUID 不可枚举。关联 [[release-ops]]（vps-ops Caddy/DNS）。

## manifest 放 VPS 同源，不放 COS（防遍历绕过隐蔽保护）

[2026-08-01] 画廊访问保护用「不索引 + 域名不公开 + COS key=UUID 难猜」（无 basic auth）。manifest 若放 COS（固定 key `relight/manifest.json` + 公有读），任何人拼 URL 可拉全量清单（含所有照片 COS 直链），绕过页面入口。

- **Lesson**：公有读桶的**固定 key 对象 = 公开**。manifest 含全量资源 URL，放 COS 等于裸奔（ListBucket 被拒也挡不住已知 key 直接 GET）。
- **Choice**：manifest 放 VPS（Caddy 同源 fetch，受 noindex + 域名不公开隐蔽）。资源放 COS 公有读但 key=UUID 难猜。「保护页面 = 保护清单入口」，单张资源即使桶公有读也猜不到。本机 job 用 child_process ssh/scp 推 manifest（不引 ssh2 依赖）。

## COS 上传容错返回空串不 throw（画廊旁路，不阻塞主流程）

[2026-08-01] gallery 同步是精选/视频主流程的**旁路**（加了给企微/画廊看，失败不应影响本地产物 + 推送）。`uploadFile` 重试 3 次后 **console.warn 返回空串，不 throw**；`syncDayToGallery` / `syncVideoToGallery` 整函数 try/catch，失败 console.warn + job.log。

- **Lesson**：旁路功能失败不能拖垮主流程。与 [[backend-infra]]「格式门 return 非 throw」、[[release-ops]]「PM2 reload in-flight」同构——容错边界用「不 throw + 记录」而非「抛错给上层」。
- **Choice**：`uploadFile` / `uploadBuffer` 返回空串（非 throw）；`sync*` 返回 `Promise<void>`（不暴露成功/失败，`pushManifest` 内部 console.log/warn 自记录）；daily-selection / daily-video 接入点双层 try/catch。COS 凭据命名兼容 `TENCENTCLOUD_*`（vps-ops 真源）/ `COS_*`（relight env 别名）—— config 优先读前者 fallback 后者。

## gallery 视频全屏（方案 B：原生全屏 API + 物理横屏引导）

[2026-08-29] 竖屏沉浸流里 16:9 横屏视频 `contain` 只占 ~26% 屏高、不沉浸。用户知情选原生全屏（接受 iOS 物理转手机），弃 CSS 伪横屏/竖版重渲染/纯排版三案。入口 = 声音按钮下方 `⛶` 圆钮，保留"点视频=切静音"。

- **Lesson**（探针实证，勿信老资料）：Chromium（@playwright/test 1.59.1 内置）`video.webkitEnterFullscreen` 是 **undefined**；`video.requestFullscreen()` 正常派发 `fullscreenchange` 且 **target 是 VIDEO 元素**。老 XWeb 可能只有前缀事件——退出监听必须 `fullscreenchange` + `webkitfullscreenchange` 双挂（restore 幂等靠 lastFullscreenVideo 空守卫）+ video 元素 `webkitendfullscreen`（iOS 原生播放器）。
- **Choice**：探测顺序 `requestFullscreen` 优先（Chromium/XWeb 全程标准事件）、`webkitEnterFullscreen` 仅 iOS WKWebView 兜底（iPhone 无 Element.requestFullscreen）；进全屏先 unmute + 未播则手势内起播，退出恢复 muted + try orientation.unlock；视频 404 用纯 CSS 门 `[data-load-state=error]` 隐藏按钮；双 API 均缺 → 单元内 toast「建议横屏观看」≤3000ms 自动隐藏。验收谓词 FS.PM1-5 见 `apps/gallery/__tests__/gallery-video-fullscreen.e2e.acceptance.test.ts`（PM3 退出断言有毫秒竞态，见 [[testing]]）。
## cos-nodejs-sdk-v5 getBucketCors 回读复数键，幂等判存与单测须双键兼容

[2026-08-30] <!-- tags: cos, sdk, cors, 单测-fixture -->

- **Scenario**：用 cos-nodejs-sdk-v5 读写桶 CORS（或任何 get/put 键名不对称的 SDK API）做幂等判断时
- **Lesson**：SDK 读回键名可能与写入键名不对称——getBucketCors 回读**复数键**（AllowedOrigins/AllowedMethods/AllowedHeaders，MaxAgeSeconds 回读为字符串），putBucketCors 则单复数都收；幂等判存必须 `复数键 ?? 单数键` 双兼容。单测 fixture 必须镜像 **SDK 真实回读 shape**（读 SDK 源码求证），而非镜像自己实现的假设——否则单测与实现共享同一错误假设，绿灯是假阴性
- **Evidence**：mergeCorsRules 只查单数键 → 生产桶被重复写入 2 条相同规则（验收谓词 C2 FAIL）；SDK base.js 单复数互转源码实证；fixture 换复数键后单测 10/10 仍绿并补去重用例（核对锚点：2026-08-30 源码版本）

## manifest 按约定 key 拼 URL 会给从未生成的对象造死链

[2026-08-30] <!-- tags: gallery, manifest, cos, 死链, 回填 -->

- **Scenario**：manifest/清单类产物按「约定 key 拼 URL」而非「上传成功回执」生成资源链接时
- **Lesson**：约定 key 拼 URL 隐含「对象必然存在」假设——晚于数据区间的功能（如竖版壁纸晚于早期精选日）会产出系统性死链，且**本地产物从未生成 ≠ 上传失败**，先盘点本地再选策略。补救首选「确定性重合成」：幂等脚本（线上 HEAD 找缺 → 从 DB 原始数据按当日管线同参重新生成 → 上传 → 复核），比改 manifest 守卫更能兑现已发布的链接；legacy 无明细表的历史行回退主记录字段
- **Evidence**：39 个历史日竖版 404（05-08~06-17 + 06-26 本地从未合成）+ 07-31 横版本地丢失；`apps/backend/scripts/recompose-wallpapers.ts` 40/40 恢复、线上 196 条壁纸直链全 200；05-08 无 dailyPickEntries 按主记录回退成功（核对锚点：2026-08-30）

## iOS 网页下载三件套：Web Share files、跨域 a.download 无效、微信引导

[2026-08-30] <!-- tags: ios, web-share, 下载, 微信, 兼容性 -->

- **Scenario**：静态站要在 iPhone 上提供图片/视频「保存到相册」能力时
- **Lesson**：iOS Safari 对跨域 URL 忽略 `<a download>`；唯一可靠路径是 Web Share API level 2（`navigator.share({files})`，iOS 15+）弹系统分享面板。三个配套坑：① `AbortSignal.timeout` 需 Safari 16+，iOS 15 同步抛 TypeError → 手动 AbortController + setTimeout；② fetch 失败后兜底 `window.open` 会因 transient activation 过期被弹窗拦截（返回 null）→ 级联 `location.href` 当前页导航；③ 微信/企微内置浏览器（群推送链接第一跳）无 Web Share → 检测 MicroMessenger UA 弹「在 Safari 中打开」引导遮罩，深链 hash 保留回原位。跨域 fetch 需目标桶配 CORS（公有读只放行标签加载，不放行 XHR）
- **Evidence**：画廊下载功能 48 条验收谓词全过；Playwright 用 addInitScript stub share/canShare + UA 注入覆盖微信分支与取消分享路径（核对锚点：2026-08-30 apps/gallery/app.js）

## 滚动吸附流的横竖屏翻转重锚与 Chromium 观测等价边界

[2026-08-31] <!-- tags: gallery, scroll-snap, orientation, 移动端, 测试边界 -->

- **Scenario**：全屏滚动吸附流（scroll-snap + 视口高单元）在手机旋转后当前屏跳变；或在桌面引擎里验证「旋转保持位置」类修复时
- **Lesson**：旋转跳变机理是 scrollTop 绝对像素保留 + re-snap 吸错单元，但**只有真机 WebKit 可复现**——Chromium 默认开 scroll anchoring 且保留 snap target，翻转时滚动位置被自动补偿到新吸附位，「修复生效 ≡ 无修复 ≡ 浏览器自然保持」三者观测等价，桌面 e2e 无法区分。此类修复桌面测试只能做回归保护+契约固化，真实载荷必须真机验证；红队断言若以「位置会漂移」为前提，先探针验证前提在测试引擎中成立，不成立则反转为用户可感契约。修复模式：跟踪当前阅读单元 + 仅朝向翻转触发（同朝向 resize 零副作用）+ 瞬时回滚（样式覆盖 scroll-behavior: smooth 后直赋 scrollTop）+ 复用既有 programmatic 滚动闸门防 URL 被过渡态固化。
- **Evidence**：探针（吞 resize 监听使修复死亡后翻转）scrollTop 仍被精确补偿（1688→780=2×390；8580→18568=22×844，均恰为新朝向吸附位）；orientation re-anchor 套件 64/64 绿但真机验证仍必要（核对锚点：2026-08-31 apps/gallery orientation re-anchor 区段）
