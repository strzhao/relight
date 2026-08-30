/**
 * 拾光画廊 · 单一垂直沉浸流（state.md §前端流引擎）
 *
 * 一个 <main id="stream"> 容器按日倒序展开流单元序列（date-separator / photo / video / wallpaper），
 * scroll-snap 逐屏吸附（抖音节奏）。视频流内全屏单元 muted autoplay。
 *
 * 数据源：同源 fetch ./manifest.json（Caddy 静态托管）。资源全走 COS 公有读直链。
 *
 * DOM 契约（红队 AX 断言依据，state.md §前端流单元 DOM 契约）：
 *   每个 [data-stream-unit] 必填：
 *     data-unit-type = photo | video | wallpaper | date-separator
 *     data-load-state = loading | loaded | error
 *   photo 单元额外：data-day-date / data-day-index / data-photo-rank / data-photo-id / data-takenat-absent
 *   video 单元额外：data-media-type="video" / data-video-id
 *   wallpaper 单元：data-role="wallpaper-card" + 底部 download-bar
 *     （旧 [data-role="save-hint"] 已按契约演进删除，被下载按钮取代——state.md 实现计划 3）
 *   下载：[data-role="photo-download" | "video-download" | "wallpaper-download-portrait"
 *     | "wallpaper-download-landscape"]，均带 aria-label + data-download-state 状态机
 *
 * 深链路由（state.md §深链路由契约）：
 *   #/                    → stream scrollTop = 0
 *   #/?date=YYYY-MM-DD    → 该 date-separator scrollIntoView
 *   #/video/<id>          → 该 video 单元 scrollIntoView + 自动 play
 */

(() => {
  const streamEl = document.getElementById("stream");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error-fallback");
  const errorMsgEl = document.querySelector('[data-role="error-msg"]');
  const hudEl = document.getElementById("hud");
  const hudDateEl = document.querySelector('[data-role="hud-date"]');

  // ============================================================================
  // manifest 获取（同源 fetch，S11 错误态）
  // ============================================================================

  let manifestCache = null;

  async function fetchManifest() {
    if (manifestCache) return manifestCache;
    const res = await fetch("./manifest.json", { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`MANIFEST_FETCH_FAILED: manifest.json 返回 ${res.status}`);
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.days)) {
      throw new Error("MANIFEST_FETCH_FAILED: manifest 结构异常，缺 days[]");
    }
    manifestCache = json;
    return json;
  }

  // ============================================================================
  // 工具函数
  // ============================================================================

  /**
   * 拍摄时刻格式化（纯函数，从 packages/shared/src/datetime.ts inline 复制——
   * 纯静态站不能 import @relight/shared）。
   *
   * @param takenAt ISO 字符串或 null/无效脏数据
   * @returns `"YYYY年MM月DD日 HH:MM"` 或 null（缺失/脏数据 → dateline 不渲染，S8.PM1/PM3）
   */
  function formatPhotoCaptureTime(takenAt) {
    if (!takenAt || typeof takenAt !== "string") return null;
    const d = new Date(takenAt);
    if (Number.isNaN(d.getTime())) return null;

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");

    return `${year}年${month}月${day}日 ${hours}:${minutes}`;
  }

  /** 计算 takenAt 距今多少年（整数） */
  function yearsAgoTaken(takenAt) {
    if (!takenAt) return null;
    const d = new Date(takenAt);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let years = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years--;
    return years >= 0 ? years : 0;
  }

  /** ISO 日期 → 中文展示（"YYYY年M月D日 周X"） */
  function fmtPickDateCn(pickDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pickDate || "");
    if (!m) return pickDate || "";
    const d = new Date(`${pickDate}T00:00:00`);
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const wd = Number.isNaN(d.getTime()) ? "" : weekdays[d.getDay()];
    return `${m[1]}年${Number(m[2])}月${Number(m[3])}日 ${wd}`;
  }

  /** 英文月份 + 星期（date-separator 卡用） */
  function fmtPickDateEn(pickDate) {
    const d = new Date(`${pickDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { monthWeek: "", dayNum: "" };
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return {
      monthWeek: `${weekdays[d.getDay()]}, ${months[d.getMonth()]}`,
      dayNum: String(d.getDate()),
    };
  }

  function fmtDuration(sec) {
    if (!sec || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "dataset") {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
      } else if (k === "style") node.setAttribute("style", v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== null && v !== undefined && v !== false) {
        node.setAttribute(k, String(v));
      }
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ============================================================================
  // 下载基础设施（state.md §方案架构 1/2/4/5）
  //
  //   shareOrDownload(url, filename, opts) — fetch → Web Share（iOS 15+ 存相册/文件）
  //     → 降级 a.download blob（桌面/旧 iOS）→ fetch 失败兜底 window.open 直链
  //   createDownloadButton — 圆形玻璃按钮 + data-download-state 状态机
  //   isWeChat / showWeChatGuide — 微信内置浏览器「在 Safari 中打开」引导遮罩
  //   showToast — 底部浮出提示，2.5s 自动消失
  // ============================================================================

  /** 下载超时默认值：图片/壁纸 60s；视频由调用方传 300s（~119MB 弱网余量） */
  const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;
  const VIDEO_DOWNLOAD_TIMEOUT_MS = 300000;

  /** 微信引导遮罩文案（纯文字 + CSS 箭头，不引图片资源） */
  const WECHAT_GUIDE_MESSAGE = "点击右下角「···」→ 在 Safari 中打开，即可下载保存";

  /** 手动 AbortController + setTimeout 实现超时信号——
   *  AbortSignal.timeout 需 Safari 16+，iOS 15 无此 API 会同步抛 TypeError，必须手动实现 */
  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 注意：timer 在 body 读完（readResponseBlob 返回）后才 clear——abort 信号对
    // 流式读 body 同样生效，超时语义是「整个下载动作」的预算而非仅响应头
    return {
      signal: controller.signal,
      done: () => clearTimeout(timer),
    };
  }

  /** 读取响应为 Blob；有 Content-Length 且调用方传了 onProgress 时走流式读回报整数百分比 0-100 */
  async function readResponseBlob(res, onProgress) {
    if (!onProgress || !res.body || typeof res.body.getReader !== "function") {
      return res.blob();
    }
    const lenHeader = res.headers.get("Content-Length");
    const total = lenHeader ? Number.parseInt(lenHeader, 10) : 0;
    if (!total || !Number.isFinite(total)) {
      // Content-Length 缺失（chunked 等）→ 无百分比依据，不调用 onProgress（§实现规约）
      return res.blob();
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const pct = Math.min(100, Math.max(0, Math.round((received / total) * 100)));
      onProgress(pct);
    }
    onProgress(100);
    return new Blob(chunks, { type: res.headers.get("Content-Type") || "" });
  }

  /** 扩展名 → MIME 推断（blob.type 为空时兜底，保证 iOS 分享面板识别文件类型） */
  function mimeFromFilename(name) {
    if (/\.jpe?g$/i.test(name)) return "image/jpeg";
    if (/\.png$/i.test(name)) return "image/png";
    if (/\.webp$/i.test(name)) return "image/webp";
    if (/\.mp4$/i.test(name)) return "video/mp4";
    if (/\.mov$/i.test(name)) return "video/quicktime";
    return "application/octet-stream";
  }

  /** fetch 失败最后兜底：开直链。异步上下文 transient activation 多已过期，
   *  window.open 会被弹窗拦截返回 null → 级联当前页导航（导航不受拦截），功能不静默失败 */
  function openDirectLink(url) {
    const w = window.open(url, "_blank");
    if (!w) location.href = url;
  }

  /** 降级路径：blob URL + <a download> 触发浏览器下载（桌面落盘 / iOS 13+ 进文件 App） */
  function triggerAnchorDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const a = el("a", { href: objectUrl, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延迟 revoke：点击处理期间 Safari 仍需解析 blob URL
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }

  /**
   * 统一下载核心（state.md §方案架构 1）。
   *
   * @returns "shared"（Web Share 面板已唤起，含用户取消的静默路径）
   *          | "downloaded"（a.download 降级落盘）
   *          | "opened"（fetch 失败兜底打开直链）
   */
  async function shareOrDownload(url, filename, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;

    // ---- 阶段 1：fetch（失败 → 兜底开直链） ----
    const t = fetchWithTimeout(url, timeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: t.signal });
      if (!res.ok) {
        t.done();
        openDirectLink(url);
        showToast("已打开原文件，可长按/右键保存");
        return "opened";
      }
    } catch {
      t.done();
      openDirectLink(url);
      showToast("已打开原文件，可长按/右键保存");
      return "opened";
    }

    // ---- 阶段 2：读 body 为 Blob（中途断流同 fetch 失败路径） ----
    let blob;
    try {
      blob = await readResponseBlob(res, onProgress);
    } catch {
      t.done();
      openDirectLink(url);
      showToast("已打开原文件，可长按/右键保存");
      return "opened";
    }
    t.done();

    // ---- 阶段 3：构造 File → Web Share 优先，降级 a.download ----
    const file = new File([blob], filename, { type: blob.type || mimeFromFilename(filename) });
    const nav = navigator;
    if (nav.canShare && nav.share) {
      try {
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file] });
          return "shared";
        }
      } catch (err) {
        if (err && err.name === "AbortError") {
          // 用户取消分享面板 → 非错误，静默返回（场景 7：不降级下载、不开直链）
          return "shared";
        }
        // 其他 share 失败（少见的 NotAllowedError 等）→ 手里已有 blob，降级下载保住文件
      }
    }
    triggerAnchorDownload(blob, filename);
    return "downloaded";
  }

  /** 文件名 sanitize：文件系统/分享面板非法字符替换为全角横线；超长截断 80 字符 */
  function sanitizeFilename(name) {
    const cleaned = String(name || "").replace(/[\\/:*?"<>|]/g, "－");
    return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  }

  /**
   * 下载按钮工厂（state.md §方案架构 2）。
   * data-download-state ∈ {idle, loading, error}；loading 时 disabled + CSS spinner，
   * 传入百分比文本时同步 aria-valuenow（0-100）供自动化断言。
   */
  function createDownloadButton(config) {
    const btn = el(
      "button",
      {
        type: "button",
        class: "download-btn",
        "data-role": config.role,
        "aria-label": config.ariaLabel,
      },
      [
        el("span", { class: "download-btn-spinner", "aria-hidden": "true" }),
        el("span", { class: "download-btn-icon", "aria-hidden": "true" }, ["⬇"]),
        el("span", { class: "download-btn-text" }, ["下载"]),
      ],
    );
    btn.dataset.downloadState = "idle";

    function setState(state, text) {
      btn.dataset.downloadState = state;
      btn.disabled = state === "loading";
      if (state === "loading") {
        if (text !== undefined && text !== null) {
          btn.querySelector(".download-btn-text").textContent = text;
          const num = /(\d+)/.exec(text);
          if (num) btn.setAttribute("aria-valuenow", num[1]);
        }
      } else {
        // 离开 loading → 复位文案与 aria-valuenow
        btn.querySelector(".download-btn-text").textContent = "下载";
        btn.removeAttribute("aria-valuenow");
      }
    }
    return { btn, setState };
  }

  // ---- 微信内置浏览器引导（state.md §方案架构 4） ----

  function isWeChat() {
    return /MicroMessenger/i.test(navigator.userAgent);
  }

  let wechatGuideEl = null;

  /** 单例遮罩：微信环境点下载 → 引导「在 Safari 中打开」（hash 深链保留，Safari 打开回原位） */
  function showWeChatGuide() {
    if (wechatGuideEl?.isConnected) {
      wechatGuideEl.hidden = false;
      return;
    }
    wechatGuideEl = el(
      "div",
      {
        class: "wechat-guide",
        "data-role": "wechat-guide",
        role: "dialog",
        "aria-label": "下载引导",
      },
      [
        el("div", { class: "wechat-guide-panel" }, [
          el("p", { class: "wechat-guide-text" }, [WECHAT_GUIDE_MESSAGE]),
          el("div", { class: "wechat-guide-arrow", "aria-hidden": "true" }, ["↗"]),
        ]),
        el(
          "button",
          {
            type: "button",
            class: "wechat-guide-close",
            "data-role": "wechat-guide-close",
            "aria-label": "关闭引导",
          },
          ["知道了"],
        ),
      ],
    );
    wechatGuideEl
      .querySelector('[data-role="wechat-guide-close"]')
      .addEventListener("click", () => {
        wechatGuideEl.hidden = true;
      });
    // 点遮罩空白处也可关闭
    wechatGuideEl.addEventListener("click", (e) => {
      if (e.target === wechatGuideEl) wechatGuideEl.hidden = true;
    });
    document.body.appendChild(wechatGuideEl);
  }

  // ---- toast（state.md §方案架构 5） ----

  let toastTimer = null;

  /** 底部浮出提示，2.5s 自动消失（CSS animation）；重复调用复用单例并刷新计时 */
  function showToast(msg) {
    let toast = document.querySelector('[data-role="download-toast"]');
    if (!toast) {
      toast = el("div", { class: "download-toast", "data-role": "download-toast" });
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    // 强制 reflow 重启 CSS 入场动画
    toast.classList.remove("is-visible");
    void toast.offsetWidth;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2500);
  }

  /**
   * 三卡接线共用点击绑定：微信分支 → 引导遮罩（不触发下载）；
   * 非微信 → 状态机 loading → shareOrDownload → 回 idle。
   * 进行中（loading）重复点击无副作用（按钮 disabled + 状态守卫双保险）。
   */
  function bindDownloadClick(btnCtl, url, filename, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const withProgress = Boolean(opts.withProgress);
    btnCtl.btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (isWeChat()) {
        showWeChatGuide();
        return;
      }
      if (btnCtl.btn.dataset.downloadState === "loading") return; // STATE_INVARIANT 防重
      btnCtl.setState("loading");
      try {
        await shareOrDownload(url, filename, {
          timeoutMs,
          onProgress: withProgress ? (pct) => btnCtl.setState("loading", `${pct}%`) : undefined,
        });
      } catch (err) {
        // shareOrDownload 已兜底全部失败路径；此处防御未预期异常，不静默卡 loading
        console.warn("[gallery] 下载未预期失败:", err);
        showToast("下载未完成，请重试");
      } finally {
        // FETCH_FAILED 契约：按钮回 idle（含兜底 opened 路径）；用户取消 share 同样回 idle
        btnCtl.setState("idle");
      }
    });
  }

  // ============================================================================
  // 视频管理（IntersectionObserver，S4/S5）
  // ============================================================================

  /** 当前正在播放的视频（多视频只播一个，S5.PM1） */
  let currentPlayingVideo = null;
  let videoIO = null;

  function ensureVideoIO() {
    if (videoIO) return videoIO;
    videoIO = new IntersectionObserver(
      (entries) => {
        // 找视口占比最高的 video 单元
        let bestEntry = null;
        let bestRatio = 0;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (entry.intersectionRatio > bestRatio) {
              bestRatio = entry.intersectionRatio;
              bestEntry = entry;
            }
          }
        }
        if (bestEntry) {
          // 暂停其他视频
          for (const e of entries) {
            if (e !== bestEntry) pauseVideoUnit(e.target);
          }
          playVideoUnit(bestEntry.target);
        } else {
          // 没有达标 → 暂停所有 entries
          for (const e of entries) pauseVideoUnit(e.target);
        }
      },
      { threshold: [0, 0.5, 0.75] },
    );
    return videoIO;
  }

  function playVideoUnit(unit) {
    const video = unit.querySelector("video");
    if (!video) return;
    if (currentPlayingVideo && currentPlayingVideo !== video) {
      // 互斥：暂停上一个
      pauseVideoUnit(currentPlayingVideo.closest("[data-stream-unit]"));
    }
    video.muted = true;
    const p = video.play();
    if (p && typeof p.then === "function") {
      p.catch(() => {
        // autoplay 被拦截，忽略（用户手势后可播）
      });
    }
    currentPlayingVideo = video;
  }

  function pauseVideoUnit(unit) {
    const video = unit.querySelector("video");
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    if (currentPlayingVideo === video) currentPlayingVideo = null;
  }

  function attachVideoProgress(video, unit) {
    const bar = unit.querySelector('[data-role="video-progress"]');
    if (!bar) return;
    video.addEventListener("timeupdate", () => {
      const dur = video.duration || 0;
      const pct = dur > 0 ? (video.currentTime / dur) * 100 : 0;
      bar.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(pct)));
    });
  }

  // ============================================================================
  // 视频全屏（原生全屏 API + 物理横屏引导）
  // ============================================================================

  /** 当前全屏中的视频元素（模块级追踪，避免多视频串扰） */
  let lastFullscreenVideo = null;
  /** 当前全屏视频所属卡的静音按钮刷新回调（renderVideoCard 内注册，退出恢复用） */
  let fullscreenSoundRestore = null;
  /** document fullscreenchange 惰性单例监听已注册标记 */
  let documentFullscreenWired = false;

  /** hint 自动隐藏计时器（按 hint 节点隔离，重复触发重置计时） */
  const hintTimers = new WeakMap();

  /**
   * 降级 toast（当前环境不支持全屏 → 提示横屏观看）：
   * ≤3000ms 自动隐藏，重复触发重置计时。仅降级路径调用。
   */
  function showVideoHint(hintEl) {
    if (!hintEl) return;
    hintEl.hidden = false;
    clearTimeout(hintTimers.get(hintEl));
    hintTimers.set(
      hintEl,
      setTimeout(() => {
        hintEl.hidden = true;
      }, 3000),
    );
  }

  /** 尝试锁横屏（typeof 守卫 + catch 静默，lock 失败不影响全屏本体） */
  function tryLockLandscape() {
    if (
      typeof screen !== "undefined" &&
      screen.orientation &&
      typeof screen.orientation.lock === "function"
    ) {
      try {
        const p = screen.orientation.lock("landscape");
        if (p && typeof p.then === "function") p.catch(() => {});
      } catch (e) {
        // 静默：部分环境 lock 会同步 throw
      }
    }
  }

  /** 解除横屏锁（typeof 守卫 + catch 静默） */
  function tryUnlockOrientation() {
    try {
      if (
        typeof screen !== "undefined" &&
        screen.orientation &&
        typeof screen.orientation.unlock === "function"
      ) {
        screen.orientation.unlock();
      }
    } catch (e) {
      // 静默
    }
  }

  /** 退出全屏恢复：回静音 + 刷新声音按钮 + 解横屏锁 */
  function restoreAfterVideoFullscreenExit() {
    if (!lastFullscreenVideo) return;
    lastFullscreenVideo.muted = true;
    if (fullscreenSoundRestore) fullscreenSoundRestore();
    lastFullscreenVideo = null;
    fullscreenSoundRestore = null;
    tryUnlockOrientation();
  }

  /**
   * document 全屏事件惰性单例监听（全屏退出 → 恢复静音）。
   * 同时挂标准 fullscreenchange 与 webkit 前缀 webkitfullscreenchange：
   * Chromium 的 video.webkitEnterFullscreen() 走 legacy 全屏路径，退出时只派发
   * 前缀事件（QA FS.PM3 实证），仅听标准事件会漏掉恢复时机。
   * restore 幂等（lastFullscreenVideo 空守卫），双事件不会重复生效。
   */
  function ensureDocumentFullscreenListener() {
    if (documentFullscreenWired) return;
    documentFullscreenWired = true;
    const onFullscreenChange = () => {
      const inactive = !(document.fullscreenElement || document.webkitFullscreenElement);
      if (inactive) restoreAfterVideoFullscreenExit();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }

  /**
   * 进视频全屏（能力探测顺序，全在按钮 click 手势内同步发起）：
   *   1. W3C requestFullscreen（Chromium / Android XWeb 均有）→ 标准事件路径，
   *      resolved 后 try 锁横屏，rejected → hint 降级
   *   2. iOS 原生 webkitEnterFullscreen（iPhone WKWebView 无 Element.requestFullscreen）
   *      → 调用（try/catch），随后 try 锁横屏；退出走 webkitendfullscreen / 前缀事件
   *   3. 两者均无 / 调用同步 throw → hint 降级
   * 进全屏前先出声：muted=false + 刷新按钮 + 未播则手势内起播（catch 忽略）。
   *
   * 顺序说明：标准优先可让 Chromium 系全程走 fullscreenchange（Chromium 的
   * webkitEnterFullscreen 是 legacy 路径，退出只派发前缀事件）；iOS 无标准
   * API 自然落入 webkit 兜底，行为不变。
   *
   * @param videoEl 目标视频元素
   * @param onSoundChange 静音态变化后的按钮刷新回调（卡内 updateSoundBtn）
   * @param hintEl 降级 toast 节点（仅降级路径显示）
   */
  function enterVideoFullscreen(videoEl, onSoundChange, hintEl) {
    ensureDocumentFullscreenListener();

    // 进全屏自动出声 + 未播则起播
    videoEl.muted = false;
    onSoundChange();
    if (videoEl.paused === true) {
      const p = videoEl.play();
      if (p && typeof p.then === "function") p.catch(() => {});
    }

    // 路径 1：W3C 全屏（退出走 document fullscreenchange）
    if (typeof videoEl.requestFullscreen === "function") {
      let req;
      try {
        req = videoEl.requestFullscreen();
      } catch (e) {
        // 同步 throw → 落入 webkit 兜底（可能仅标准 API 异常而 legacy 可用）
        return enterVideoFullscreenViaWebkit(videoEl, hintEl);
      }
      if (req && typeof req.then === "function") {
        req
          .then(() => tryLockLandscape())
          .catch(() => {
            // FULLSCREEN_REJECTED → hint 降级
            showVideoHint(hintEl);
          });
      } else {
        tryLockLandscape();
      }
      return;
    }

    // 路径 2：iOS 原生播放器 legacy 兜底（退出走 webkitendfullscreen / 前缀事件）
    enterVideoFullscreenViaWebkit(videoEl, hintEl);
  }

  /** legacy webkitEnterFullscreen 路径（iOS 原生播放器；不可用则 hint 降级） */
  function enterVideoFullscreenViaWebkit(videoEl, hintEl) {
    if (typeof videoEl.webkitEnterFullscreen !== "function") {
      // 路径 3：FULLSCREEN_UNSUPPORTED → hint 降级
      showVideoHint(hintEl);
      return;
    }
    try {
      videoEl.webkitEnterFullscreen();
      tryLockLandscape();
    } catch (e) {
      // 同步 throw → hint 降级
      showVideoHint(hintEl);
    }
  }

  // ============================================================================
  // 流单元渲染（4 类）
  // ============================================================================

  /** date-separator 卡 */
  function renderDateSeparator(day, dayIndex) {
    const { monthWeek, dayNum } = fmtPickDateEn(day.pickDate);
    const photoCount = (day.photos || []).length;
    const hasVideo = Boolean(getVideoForDay(day.pickDate));
    const total = photoCount + (hasVideo ? 1 : 0);

    const unit = el(
      "section",
      {
        class: "unit-date-separator",
        dataset: {
          streamUnit: "",
          unitType: "date-separator",
          dayDate: day.pickDate,
          dayIndex: String(dayIndex),
          loadState: "loaded",
          role: "date-separator",
        },
      },
      [
        el("div", { class: "date-day" }, [dayNum]),
        el("div", { class: "date-meta" }, [
          el("div", { class: "date-month-week" }, [monthWeek]),
          el("div", { class: "date-cn" }, [fmtPickDateCn(day.pickDate)]),
        ]),
        el("div", { class: "date-count" }, [`${total} 张`]),
        el("div", { class: "date-hint" }, ["继续上滑 ↓"]),
      ],
    );
    return unit;
  }

  /** photo 卡（全屏图 + 渐变遮罩 + 压字，S1/S3/S8/S9） */
  function renderPhotoCard(photo, day, dayIndex, totalPhotos) {
    // takenAt 真值 + 有效日期校验（S8.PM3：脏字符串 "undefined"/"" → 视为缺失）
    const dateline = formatPhotoCaptureTime(photo.takenAt);
    const takenAtAbsent = dateline === null;
    const years = yearsAgoTaken(photo.takenAt);
    const datelineText = dateline && years !== null ? `拍摄于 ${dateline} · ${years} 年前` : null;

    // 占位防 CLS：width/height 有效 → 用真实比；缺失（=0）→ fallback 3/4（S9.PM1）
    const hasDim = photo.width > 0 && photo.height > 0;
    const aspectRatio = hasDim ? `${photo.width}/${photo.height}` : "3/4";
    const isLandscape = hasDim ? photo.width >= photo.height : false;

    const photoUnit = el(
      "section",
      {
        class: `unit-photo${isLandscape ? " is-landscape" : ""}`,
        dataset: {
          streamUnit: "",
          unitType: "photo",
          dayDate: day.pickDate,
          dayIndex: String(dayIndex),
          photoRank: String(photo.rank),
          photoId: photo.photoId,
          takenatAbsent: takenAtAbsent ? "true" : "false",
          loadState: "loading",
          role: "photo-card",
        },
      },
      [],
    );

    // photo-frame（aspect-ratio 占位 + blur 背景 + 主图）
    const frame = el("div", { class: "photo-frame", style: `aspect-ratio:${aspectRatio};` });

    // blur-up 占位（thumbnail 800px）
    const blur = el("img", {
      class: "photo-blur",
      src: photo.thumbnail,
      alt: "",
      loading: "lazy",
      decoding: "async",
      "aria-hidden": "true",
    });
    blur.addEventListener("error", () => {
      photoUnit.dataset.loadState = "error";
    });

    // 主图（original = mid ~1600px）；加载完替换 blur，mid 404 → onerror fallback thumb（S9.PM3）
    const mainImg = el("img", {
      class: "photo-img",
      src: photo.original,
      alt: photo.title || "",
      loading: "lazy",
      decoding: "async",
    });
    mainImg.addEventListener("load", () => {
      mainImg.classList.add("is-loaded");
      photoUnit.dataset.loadState = "loaded";
    });
    mainImg.addEventListener("error", () => {
      // mid 失败 → fallback thumbnail 一次（S9.PM3：currentSrc 含 -thumb.jpg 不阻断）。
      // 用 mainImg.dataset.fallbackTried 记录是否已尝试过 thumbnail，避免 thumb 再 404 时
      // 因 original !== thumbnail 永远走 loaded 分支（S12：mid+thumb 都 404 应进 error 态）。
      if (photo.original !== photo.thumbnail && !mainImg.dataset.fallbackTried) {
        mainImg.dataset.fallbackTried = "1";
        mainImg.src = photo.thumbnail;
        mainImg.classList.add("is-loaded");
        photoUnit.dataset.loadState = "loaded";
      } else {
        // thumbnail 也失败（或 original 本就 === thumbnail）→ 真正 error 态
        photoUnit.dataset.loadState = "error";
      }
    });

    // 人脸聚焦：竖图 cover 时按 faceFocus 设 object-position 让脸居中（横图 contain 不裁不设）；
    // blur 同步避免主图脸居中、模糊背景仍 center 的割裂（S17.PM3）
    if (photo.faceFocus && !isLandscape) {
      const fx = (photo.faceFocus.x * 100).toFixed(2);
      const fy = (photo.faceFocus.y * 100).toFixed(2);
      mainImg.style.objectPosition = `${fx}% ${fy}%`;
      blur.style.objectPosition = `${fx}% ${fy}%`;
    }

    frame.appendChild(blur);
    frame.appendChild(mainImg);
    photoUnit.appendChild(frame);

    // 渐变遮罩
    photoUnit.appendChild(el("div", { class: "photo-mask" }));

    // 右上序号
    photoUnit.appendChild(el("div", { class: "photo-rank" }, [`${photo.rank} / ${totalPhotos}`]));

    // 下载按钮（photo-rank 下方）。original 空串 → 不渲染死链下载控件（场景 11.P4）
    if (photo.original) {
      const dl = createDownloadButton({
        role: "photo-download",
        ariaLabel: `下载这张照片：${photo.title || "拾光"}`,
      });
      bindDownloadClick(dl, photo.original, `拾光-${day.pickDate}-${photo.rank}.jpg`);
      photoUnit.appendChild(dl.btn);
    }

    // 底部文字（title + narrative + dateline）
    const textChildren = [
      el("h2", { class: "photo-title", "data-role": "title" }, [photo.title || "拾光"]),
      el("p", { class: "photo-narrative", "data-role": "narrative" }, [photo.narrative || ""]),
    ];
    // dateline 节点：takenAt 缺失/脏数据 → 不渲染（S8.PM1/PM3）
    if (datelineText) {
      textChildren.push(
        el("p", { class: "photo-dateline", "data-role": "dateline" }, [datelineText]),
      );
    }
    // 注意：takenAtAbsent=true 时 dateline 节点不存在（S8.PM1 assert 元素为 null）
    photoUnit.appendChild(el("div", { class: "photo-text" }, textChildren));

    return photoUnit;
  }

  /** video 卡（全屏 contain + 模糊填充 + muted autoplay，S4/S5） */
  function renderVideoCard(video, dayIndex) {
    const dur = fmtDuration(video.durationSec);
    const themeLabel =
      video.themeKind === "trip" ? "旅行" : video.themeKind === "person" ? "人物" : "回忆";

    const unit = el(
      "section",
      {
        class: "unit-video",
        dataset: {
          streamUnit: "",
          unitType: "video",
          mediaType: "video",
          videoId: video.themeKey,
          dayIndex: String(dayIndex),
          loadState: "loading",
          role: "video-card",
        },
      },
      [],
    );

    const stage = el("div", { class: "video-stage" });

    // 模糊背景填充（cover 封面）
    const blur = el("img", {
      class: "video-blur",
      src: video.cover,
      alt: "",
      loading: "lazy",
      decoding: "async",
      "aria-hidden": "true",
    });
    blur.addEventListener("error", () => {
      // 封面 404 → 隐藏 blur（视频仍可播）
      blur.style.display = "none";
    });
    stage.appendChild(blur);

    // video 元素
    const videoEl = el("video", {
      class: "video-el",
      src: video.mp4,
      poster: video.cover,
      playsinline: "",
      preload: "metadata",
      "webkit-playsinline": "",
    });
    videoEl.muted = true;
    videoEl.addEventListener("loadeddata", () => {
      unit.dataset.loadState = "loaded";
    });
    videoEl.addEventListener("error", () => {
      // 视频 404 → 单元 error 态（S13.PM1），回退 cover 静图（poster 仍显示）
      unit.dataset.loadState = "error";
    });
    // 单击切换 muted（S4.PM3）
    videoEl.addEventListener("click", () => {
      videoEl.muted = !videoEl.muted;
      updateSoundBtn();
    });
    stage.appendChild(videoEl);

    unit.appendChild(stage);

    // 顶部 tag
    unit.appendChild(el("div", { class: "video-tag" }, [themeLabel]));

    // 声音按钮
    const soundBtn = el(
      "button",
      {
        type: "button",
        class: "video-sound",
        "data-role": "video-sound",
        "aria-label": "切换声音",
      },
      ["🔇"],
    );
    function updateSoundBtn() {
      soundBtn.textContent = videoEl.muted ? "🔇" : "🔊";
    }
    soundBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      videoEl.muted = !videoEl.muted;
      updateSoundBtn();
    });
    unit.appendChild(soundBtn);

    // 降级 toast（当前环境不支持全屏 → 提示横屏观看，默认不可见）
    const videoHint = el(
      "div",
      {
        class: "video-hint",
        "data-role": "video-hint",
        hidden: "",
      },
      ["当前环境不支持全屏，建议横屏观看"],
    );

    // 全屏按钮（声音按钮正下方同列；click stopPropagation 不触发视频静音切换）
    const fullscreenBtn = el(
      "button",
      {
        type: "button",
        class: "video-fullscreen",
        "data-role": "video-fullscreen",
        "aria-label": "全屏观看",
      },
      ["⛶"],
    );
    fullscreenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // 模块级追踪当前全屏视频 + 注册本卡静音恢复回调（避免多视频串扰）
      lastFullscreenVideo = videoEl;
      fullscreenSoundRestore = updateSoundBtn;
      enterVideoFullscreen(videoEl, updateSoundBtn, videoHint);
    });
    // iOS 原生播放器退出（webkitEnterFullscreen 不走 document fullscreenchange）
    videoEl.addEventListener("webkitendfullscreen", (e) => {
      if (e.target !== lastFullscreenVideo) return;
      restoreAfterVideoFullscreenExit();
    });
    unit.appendChild(fullscreenBtn);
    unit.appendChild(videoHint);
    // 下载按钮（声音按钮下方同列）。mp4 空串 → 不渲染死链下载控件（场景 11.P1）；
    // 300s 超时 + onProgress 回报 loading 百分比（aria-valuenow 同步，场景 3.P4）
    if (video.mp4) {
      const dl = createDownloadButton({
        role: "video-download",
        ariaLabel: `下载这个视频：${video.title || "未命名视频"}`,
      });
      const baseName = video.title ? sanitizeFilename(video.title) : `拾光视频-${video.themeKey}`;
      bindDownloadClick(dl, video.mp4, `${baseName}.mp4`, {
        timeoutMs: VIDEO_DOWNLOAD_TIMEOUT_MS,
        withProgress: true,
      });
      unit.appendChild(dl.btn);
    }

    // 底部文字 + 进度条
    const metaParts = [];
    if (dur) metaParts.push(dur);
    metaParts.push("主题视频");
    metaParts.push(fmtCreatedAtDate(video.createdAt));

    unit.appendChild(
      el("div", { class: "video-text" }, [
        el("h2", { class: "video-title", "data-role": "title" }, [video.title || "未命名视频"]),
        el("p", { class: "video-meta" }, [metaParts.join(" · ")]),
        el("div", { class: "video-progress-track" }, [
          el("div", {
            class: "video-progress",
            "data-role": "video-progress",
            role: "progressbar",
            "aria-valuenow": "0",
            "aria-valuemin": "0",
            "aria-valuemax": "100",
          }),
        ]),
      ]),
    );

    attachVideoProgress(videoEl, unit);

    // 注册到视频 IO
    ensureVideoIO().observe(unit);

    return unit;
  }

  /** wallpaper 卡（contain + 保存提示，S6/S7） */
  function renderWallpaperCard(day, dayIndex) {
    const unit = el(
      "section",
      {
        class: "unit-wallpaper",
        dataset: {
          streamUnit: "",
          unitType: "wallpaper",
          dayDate: day.pickDate,
          dayIndex: String(dayIndex),
          loadState: "loading",
          role: "wallpaper-card",
        },
      },
      [],
    );

    const img = el("img", {
      class: "wallpaper-img",
      src: day.wallpaperPortrait,
      alt: `${day.title || "拾光"} 手机壁纸`,
      loading: "lazy",
      decoding: "async",
    });
    img.addEventListener("load", () => {
      unit.dataset.loadState = "loaded";
    });
    img.addEventListener("error", () => {
      // 竖版壁纸 404（历史未生成）→ 单元 error 态（前端容错，不阻断后续单元）
      unit.dataset.loadState = "error";
    });
    unit.appendChild(img);

    // 底部下载按钮排（取代旧 save-hint「长按图片保存到相册」——契约演进见 state.md 实现计划 3：
    // 长按语义被下载按钮覆盖且优于长按，S6.PM2 已按契约演进协议同步反转）。
    // 竖版主按钮常驻（本卡仅在 wallpaperPortrait 非空时渲染）；横版次按钮仅直链非空时渲染（场景 11.P2）。
    const bar = el("div", { class: "download-bar" });
    const portraitDl = createDownloadButton({
      role: "wallpaper-download-portrait",
      ariaLabel: "下载手机竖版壁纸",
    });
    bindDownloadClick(portraitDl, day.wallpaperPortrait, `拾光壁纸-${day.pickDate}-手机竖版.jpg`);
    bar.appendChild(portraitDl.btn);
    if (day.wallpaperLandscape) {
      const landscapeDl = createDownloadButton({
        role: "wallpaper-download-landscape",
        ariaLabel: "下载桌面横版壁纸",
      });
      bindDownloadClick(
        landscapeDl,
        day.wallpaperLandscape,
        `拾光壁纸-${day.pickDate}-桌面横版.jpg`,
      );
      bar.appendChild(landscapeDl.btn);
    }
    unit.appendChild(bar);

    return unit;
  }

  // ============================================================================
  // 视频归属日（state.md §视频归属日契约）
  // ============================================================================

  let videoByDateCache = null;
  let unmatchedVideosCache = null;

  function buildVideoIndex(manifest) {
    if (videoByDateCache) return;
    videoByDateCache = new Map(); // pickDate(YYYY-MM-DD) → video
    unmatchedVideosCache = []; // createdAt 归属日无对应 day 的视频
    for (const v of manifest.videos || []) {
      const dayKey = (v.createdAt || "").slice(0, 10);
      if (dayKey) {
        // 仅当存在 day.pickDate === 归属日时挂到该日；否则放 unmatched
        const hasDay = (manifest.days || []).some((d) => d.pickDate === dayKey);
        if (hasDay) {
          videoByDateCache.set(dayKey, v);
        } else {
          unmatchedVideosCache.push(v);
        }
      } else {
        unmatchedVideosCache.push(v);
      }
    }
  }

  function getVideoForDay(pickDate) {
    return videoByDateCache ? videoByDateCache.get(pickDate) : null;
  }

  function fmtCreatedAtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  }

  // ============================================================================
  // 流展开（按日倒序，增量挂载）
  // ============================================================================

  let manifestState = null;
  let sortedDays = []; // 倒序（最新在前）
  let mountedDayCount = 0; // 已挂载天数（含 unmatched 视频区）

  /** 计算某一日的所有流单元（不含 date-separator 之前的） */
  function buildDayUnits(day, dayIndex) {
    const units = [];
    const totalPhotos = (day.photos || []).length;
    // 今日（流顶最新一天，dayIndex=0）跳过 date-separator——
    // 流顶即今日，无需"新一天"分隔；且 S1.PM1 要求首单元是今日 rank=1 photo，
    // date-separator 不应作为流首单元。历史日（dayIndex>=1）保留 date-separator 作过渡分隔。
    const isStreamTop = dayIndex === 0;

    // date-separator（流顶跳过）
    if (!isStreamTop) {
      units.push(renderDateSeparator(day, dayIndex));
    }

    // video（归属日匹配 → 插该日序列首位，date-separator 之后、photo 之前）
    const video = getVideoForDay(day.pickDate);
    if (video) {
      units.push(renderVideoCard(video, dayIndex));
    }

    // photos（rank 升序）
    for (const photo of day.photos || []) {
      units.push(renderPhotoCard(photo, day, dayIndex, totalPhotos));
    }

    // wallpaper（wallpaperPortrait 非空时）
    if (day.wallpaperPortrait) {
      units.push(renderWallpaperCard(day, dayIndex));
    }

    return units;
  }

  /** 挂载下一天的单元到 stream */
  function appendNextDay() {
    if (mountedDayCount >= sortedDays.length) {
      // 流末尾：挂 unmatched 视频区（如有）
      if (unmatchedVideosCache && unmatchedVideosCache.length > 0 && !state.unmatchedMounted) {
        for (const v of unmatchedVideosCache) {
          streamEl.appendChild(renderVideoCard(v, -1));
        }
        state.unmatchedMounted = true;
      }
      return;
    }
    const day = sortedDays[mountedDayCount];
    const units = buildDayUnits(day, mountedDayCount);
    for (const u of units) streamEl.appendChild(u);
    mountedDayCount++;
  }

  const state = { unmatchedMounted: false, sentinel: null, dayIO: null };

  /** 初始挂载：流顶 unmatched 区 + 今日 + 次日（≤ 45 单元，S10.PM1） */
  function mountInitial() {
    streamEl.replaceChildren();
    mountedDayCount = 0;
    state.unmatchedMounted = false;

    // 增量挂载 sentinel（监听进入视口 → append 下一天）
    const sentinel = el("div", { dataset: { role: "load-sentinel" } });
    state.sentinel = sentinel;

    // 挂今日 + 次日
    appendNextDay();
    appendNextDay();

    streamEl.appendChild(sentinel);

    // IO 监听 sentinel
    state.dayIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            // sentinel 可见 → 至少还有 1 天未挂载，append 下一天并重新插 sentinel
            appendNextDay();
            // 重新追加 sentinel 到末尾（保持监听）
            streamEl.appendChild(sentinel);
            // 检查是否挂完
            if (mountedDayCount >= sortedDays.length && state.unmatchedMounted) {
              state.dayIO.disconnect();
            }
          }
        }
      },
      { rootMargin: "0px 0px 400px 0px" },
    );
    state.dayIO.observe(sentinel);
  }

  // ============================================================================
  // HUD 滚动联动
  // ============================================================================

  let scrollTimer = null;
  let hudIO = null;

  // URL 随滑动变化（S18）：debounce + 防循环三闸门
  let urlUpdateTimer = null;
  let lastSyncedUnitKey = null; // 闸门②：同一单元不重复 setHash（IO 多次触发去重）
  let programmaticScrollUntil = 0; // 闸门①：此时刻前的 scroll 是 scrollIntoView 触发，忽略 URL 更新

  /** 滚动停在某单元时，把 URL 同步为该单元深链（debounce 300ms + replaceState 不触发 hashchange） */
  function scheduleUrlSync(unit) {
    if (Date.now() < programmaticScrollUntil) return; // 闸门①：programmatic scroll 期间忽略
    const unitType = unit.dataset.unitType;
    if (unitType === "wallpaper") return; // 日末尾，URL 停在最后一张 photo
    let key;
    let hash;
    if (unitType === "photo") {
      key = `photo:${unit.dataset.dayDate}:${unit.dataset.photoRank}`;
      hash = `#/?date=${unit.dataset.dayDate}&rank=${unit.dataset.photoRank}`;
    } else if (unitType === "date-separator") {
      key = `sep:${unit.dataset.dayDate}`;
      hash = `#/?date=${unit.dataset.dayDate}`;
    } else if (unitType === "video") {
      key = `video:${unit.dataset.videoId}`;
      hash = `#/video/${unit.dataset.videoId}`;
    } else {
      return;
    }
    if (key === lastSyncedUnitKey) return; // 闸门②
    lastSyncedUnitKey = key;
    clearTimeout(urlUpdateTimer);
    urlUpdateTimer = setTimeout(() => {
      if (window.location.hash !== hash) {
        history.replaceState(null, "", hash); // 闸门③：不触发 hashchange，根上断环
      }
    }, 300);
  }

  function setupHudScroll() {
    // 滚动时半透明
    streamEl.addEventListener(
      "scroll",
      () => {
        hudEl.classList.add("is-scrolling");
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => hudEl.classList.remove("is-scrolling"), 200);
      },
      { passive: true },
    );

    // HUD 日期跟随视口中央单元
    hudIO = new IntersectionObserver(
      (entries) => {
        let best = null;
        let bestRatio = 0;
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            best = e.target;
          }
        }
        if (best) {
          const dayDate = best.dataset.dayDate;
          if (dayDate) {
            hudDateEl.textContent = fmtPickDateCn(dayDate);
          }
          scheduleUrlSync(best); // URL 随滚动联动（S18）
        }
      },
      { threshold: [0.25, 0.5, 0.75] },
    );
  }

  // ============================================================================
  // 深链路由
  // ============================================================================

  function getHash() {
    const h = window.location.hash || "#/";
    return h.replace(/^#/, "");
  }

  function handleDeeplink() {
    const hash = getHash();

    // #/video/<id>
    const videoMatch = /^\/video\/([\w-]+)/.exec(hash);
    if (videoMatch) {
      const id = videoMatch[1];
      const unit = document.querySelector(`[data-video-id="${id}"]`);
      if (unit) {
        programmaticScrollUntil = Date.now() + 800; // 闸门①：防 scrollIntoView 触发 IO 改 URL 死循环
        unit.scrollIntoView({ behavior: "smooth", block: "start" });
        // 自动播（IO 也会触发，但显式 play 确保深链直达立即播）
        setTimeout(() => playVideoUnit(unit), 400);
      }
      return;
    }

    // #/?date=YYYY-MM-DD[&rank=N]（有 rank → 照片深链，无 rank → date-separator）
    const dateMatch = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(hash);
    if (dateMatch) {
      const date = dateMatch[1];
      const rankMatch = /[?&]rank=(\d+)/.exec(hash);
      programmaticScrollUntil = Date.now() + 800; // 闸门①
      if (rankMatch) {
        const rank = rankMatch[1];
        const unit = document.querySelector(
          `[data-unit-type="photo"][data-day-date="${date}"][data-photo-rank="${rank}"]`,
        );
        if (unit) {
          unit.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          // 该日未挂载 OR rank 不存在 → 先 append 该日再定位
          scrollToUnloadedDate(date, rank);
        }
      } else {
        const unit = document.querySelector(
          `[data-unit-type="date-separator"][data-day-date="${date}"]`,
        );
        if (unit) {
          unit.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          // 该日尚未挂载 → 挂载所有更旧的日直到该日出现
          scrollToUnloadedDate(date);
        }
      }
      return;
    }

    // #/ 默认回顶
    streamEl.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** 该日尚未增量挂载时，逐日 append 直到出现；rank 给定时优先定位该 photo 单元 */
  function scrollToUnloadedDate(date, rank) {
    const sortedIdx = sortedDays.findIndex((d) => d.pickDate === date);
    if (sortedIdx < 0) return;
    // 挂载到 sortedIdx+1 天（mountedDayCount 是数量，sortedIdx 是索引）
    while (mountedDayCount <= sortedIdx && mountedDayCount < sortedDays.length) {
      appendNextDay();
    }
    // sentinel 重插
    if (state.sentinel) streamEl.appendChild(state.sentinel);
    // 延迟一帧确保 DOM 渲染
    requestAnimationFrame(() => {
      const selector = rank
        ? `[data-unit-type="photo"][data-day-date="${date}"][data-photo-rank="${rank}"]`
        : `[data-unit-type="date-separator"][data-day-date="${date}"]`;
      let unit = document.querySelector(selector);
      if (!unit && rank) {
        // rank 不存在（如分享链接的 rank 已变）→ fallback 该日 date-separator
        unit = document.querySelector(`[data-unit-type="date-separator"][data-day-date="${date}"]`);
      }
      if (unit) unit.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ============================================================================
  // 错误态（S11）
  // ============================================================================

  function showError(err) {
    loadingEl.hidden = true;
    streamEl.hidden = true;
    hudEl.hidden = true;
    errorEl.hidden = false;
    if (errorMsgEl) {
      errorMsgEl.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function hideLoading() {
    loadingEl.hidden = true;
  }

  // ============================================================================
  // 启动
  // ============================================================================

  async function init() {
    // retry button（S11.PM2）
    const retryBtn = document.querySelector('[data-role="retry-button"]');
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        errorEl.hidden = true;
        loadingEl.hidden = false;
        streamEl.hidden = false;
        hudEl.hidden = false;
        manifestCache = null;
        init();
      });
    }

    try {
      const manifest = await fetchManifest();
      manifestState = manifest;
      buildVideoIndex(manifest);
      // days 倒序（最新在前）
      sortedDays = (manifest.days || [])
        .slice()
        .sort((a, b) => b.pickDate.localeCompare(a.pickDate));

      hideLoading();
      mountInitial();
      setupHudScroll();

      // HUD IO 观察所有已挂载单元（增量挂载的新单元也需观察——用 mutation observer）
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && node.dataset && node.dataset.streamUnit !== undefined) {
              if (hudIO) hudIO.observe(node);
            }
          }
        }
      });
      mo.observe(streamEl, { childList: true });
      // 已有单元也观察
      for (const u of streamEl.querySelectorAll("[data-stream-unit]")) {
        if (hudIO) hudIO.observe(u);
      }

      // hash 变化触发深链
      window.addEventListener("hashchange", handleDeeplink);
      // 首次加载处理深链
      requestAnimationFrame(() => handleDeeplink());
    } catch (err) {
      console.error("[gallery] 初始化失败:", err);
      showError(err);
    }
  }

  init();
})();
