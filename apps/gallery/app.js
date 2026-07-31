/**
 * 拾光画廊静态站（state.md §组件设计 7）
 *
 * 单页应用，原生 JS 无框架。hash 路由：
 *   #/          — 今日精选（DailyHero 布局：左大图 + 右叙事 + 底部缩略图栅格）
 *   #/history   — 历史精选列表
 *   #/video/<id>— 视频播放
 *
 * 数据源：同源 fetch ./manifest.json（VPS Caddy 静态托管，state.md §组件设计 7/8）。
 * 资源全走 COS 公有读直链（manifest 内已拼好 URL）。
 *
 * data-role 属性（红队 AX 断言用）：
 *   hero / hero-date / hero-title / narrative / thumb-grid / thumb / video / video-title
 *   day-list / day-thumb / error / loading
 */

(() => {
  const appEl = document.getElementById("app");

  // ============================================================================
  // manifest 获取（同源 fetch，带缓存失败提示）
  // ============================================================================

  let manifestCache = null;

  async function fetchManifest() {
    if (manifestCache) return manifestCache;
    const res = await fetch("./manifest.json", { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`manifest.json 返回 ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json") && !ct.includes("text/plain")) {
      // Caddy 可能返回 json 但 ct 为 application/json；text/plain 兜底（本地 file:// 调试）
      console.warn(`[gallery] manifest content-type 非典型: ${ct}`);
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.days)) {
      throw new Error("manifest 结构异常：缺 days[]");
    }
    manifestCache = json;
    return json;
  }

  // ============================================================================
  // 工具：模板克隆
  // ============================================================================

  function cloneTpl(id) {
    const tpl = document.getElementById(id);
    if (!tpl) throw new Error(`模板 #${id} 未找到`);
    return tpl.content.cloneNode(true);
  }

  function fmtDate(pickDate) {
    // YYYY-MM-DD → YYYY 年 M 月 D 日
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pickDate || "");
    if (!m) return pickDate || "";
    return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
  }

  function fmtDuration(sec) {
    if (!sec || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setActiveNav(route) {
    for (const a of document.querySelectorAll(".nav a")) {
      const nav = a.getAttribute("data-nav");
      a.classList.toggle("active", nav === route);
    }
  }

  // ============================================================================
  // 路由：今日精选 #/
  // ============================================================================

  function renderToday(manifest) {
    // 取最新一天（days 已升序，末尾最新；若未来改降序则取 [0]）
    const days = manifest.days || [];
    const day = days[days.length - 1] || days[0];
    if (!day) {
      renderEmpty("还没有精选照片");
      return;
    }

    const frag = cloneTpl("today-tpl");
    const heroImg = frag.querySelector('[data-role="hero"]');
    const heroDate = frag.querySelector('[data-role="hero-date"]');
    const heroTitle = frag.querySelector('[data-role="hero-title"]');
    const narrative = frag.querySelector('[data-role="narrative"]');
    const thumbGrid = frag.querySelector('[data-role="thumb-grid"]');

    // hero 图：有壁纸用横版，否则用第一张缩略图
    const photos = day.photos || [];
    const firstPhoto = photos[0];
    if (day.wallpaperLandscape) {
      heroImg.src = day.wallpaperLandscape;
      heroImg.alt = day.title || "今日精选";
    } else if (firstPhoto?.thumbnail) {
      heroImg.src = firstPhoto.thumbnail;
      heroImg.alt = day.title || "今日精选";
    } else {
      heroImg.style.display = "none";
    }

    heroDate.textContent = fmtDate(day.pickDate);
    heroTitle.textContent = day.title || "今日拾光";
    narrative.textContent = day.narrative || "";

    // 缩略图栅格：点击切换 hero
    for (const p of photos) {
      if (!p.thumbnail) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      btn.setAttribute("data-role", "thumb");
      btn.setAttribute("data-photo-id", p.photoId || "");
      btn.setAttribute("aria-label", p.title || "查看照片");
      const img = document.createElement("img");
      img.src = p.thumbnail;
      img.alt = p.title || "";
      img.loading = "lazy";
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        // 点击 thumb[N] → hero 切换为该 thumb 的 original URL（P29 谓词）
        heroImg.src = p.original || p.thumbnail;
        heroImg.alt = p.title || "";
        for (const t of thumbGrid.querySelectorAll(".thumb")) {
          t.setAttribute("aria-selected", "false");
        }
        btn.setAttribute("aria-selected", "true");
      });
      thumbGrid.appendChild(btn);
    }

    // 竖版壁纸（手机用）：附加在 hero-section 底部
    if (day.wallpaperPortrait) {
      const portrait = document.createElement("div");
      portrait.className = "portrait-wallpaper";
      const pImg = document.createElement("img");
      pImg.src = day.wallpaperPortrait;
      pImg.alt = `${day.title || ""} 手机壁纸`;
      pImg.loading = "lazy";
      portrait.appendChild(pImg);
      frag.querySelector(".hero-section").appendChild(portrait);
    }

    appEl.replaceChildren(frag);
    setActiveNav("today");
  }

  // ============================================================================
  // 路由：历史列表 #/history
  // ============================================================================

  function renderHistory(manifest) {
    const days = (manifest.days || []).slice().reverse(); // 最新在前
    const frag = cloneTpl("history-tpl");
    const list = frag.querySelector('[data-role="day-list"]');

    if (days.length === 0) {
      renderEmpty("还没有历史精选");
      return;
    }

    for (const day of days) {
      const li = document.createElement("li");
      li.className = "day-item";

      const thumb = document.createElement("img");
      thumb.className = "day-thumb";
      thumb.loading = "lazy";
      const firstPhoto = (day.photos || [])[0];
      thumb.src = day.wallpaperLandscape || firstPhoto?.thumbnail || "";
      thumb.alt = day.title || "";

      const info = document.createElement("div");
      info.className = "day-info";
      const dateP = document.createElement("p");
      dateP.className = "day-date";
      dateP.textContent = fmtDate(day.pickDate);
      const titleH = document.createElement("h3");
      titleH.className = "day-title";
      titleH.textContent = day.title || "拾光";
      info.appendChild(dateP);
      info.appendChild(titleH);

      const count = document.createElement("span");
      count.className = "day-count";
      const photoCount = (day.photos || []).length;
      count.textContent = `${photoCount} 张`;
      if (!day.wallpaperLandscape) {
        const badge = document.createElement("span");
        badge.className = "day-no-wallpaper";
        badge.textContent = "无壁纸";
        count.appendChild(badge);
      }

      li.appendChild(thumb);
      li.appendChild(info);
      li.appendChild(count);
      // 点击进入当日详情（复用今日视图，临时替换 hero）
      li.addEventListener("click", () => {
        window.location.hash = `#/?date=${day.pickDate}`;
      });
      list.appendChild(li);
    }

    appEl.replaceChildren(frag);
    setActiveNav("history");
  }

  // ============================================================================
  // 路由：视频播放 #/video/<id>
  // ============================================================================

  function renderVideo(manifest, videoId) {
    const videos = manifest.videos || [];
    const video = videos.find((v) => v.id === videoId);
    if (!video) {
      renderEmpty(`视频 ${videoId} 不存在或已下线`);
      return;
    }

    const frag = cloneTpl("video-tpl");
    const player = frag.querySelector('[data-role="video"]');
    const title = frag.querySelector('[data-role="video-title"]');
    const meta = frag.querySelector('[data-role="video-meta"]');

    title.textContent = video.title || "未命名视频";
    player.src = video.mp4 || "";
    if (video.cover) {
      player.poster = video.cover;
    }

    const parts = [];
    if (video.themeKind === "trip") parts.push("旅行");
    else if (video.themeKind === "person") parts.push("人物");
    const dur = fmtDuration(video.durationSec);
    if (dur) parts.push(dur);
    meta.textContent = parts.join(" · ");

    appEl.replaceChildren(frag);
    setActiveNav("");
  }

  // ============================================================================
  // 空态 / 错误态
  // ============================================================================

  function renderEmpty(msg) {
    appEl.replaceChildren();
    const div = document.createElement("div");
    div.className = "loading";
    div.setAttribute("data-role", "empty");
    const p = document.createElement("p");
    p.textContent = msg;
    div.appendChild(p);
    appEl.appendChild(div);
  }

  function renderError(err) {
    const frag = cloneTpl("error-tpl");
    const msgEl = frag.querySelector(".error-msg");
    msgEl.textContent = err instanceof Error ? err.message : String(err);
    frag.querySelector(".btn-retry").addEventListener("click", () => {
      manifestCache = null;
      route();
    });
    appEl.replaceChildren(frag);
  }

  // ============================================================================
  // 路由分发
  // ============================================================================

  function getHash() {
    const h = window.location.hash || "#/";
    return h.replace(/^#/, "");
  }

  async function route() {
    const hash = getHash();
    try {
      const manifest = await fetchManifest();

      // #/video/<id>
      const videoMatch = /^\/video\/([\w-]+)/.exec(hash);
      if (videoMatch) {
        renderVideo(manifest, videoMatch[1]);
        return;
      }

      // #/history
      if (hash === "/history") {
        renderHistory(manifest);
        return;
      }

      // #/?date=YYYY-MM-DD（历史列表点击跳转，当日详情）
      const dateMatch = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(hash);
      if (dateMatch) {
        const day = (manifest.days || []).find((d) => d.pickDate === dateMatch[1]);
        if (day) {
          // 临时把该日放到末尾复用 renderToday（不修改缓存原对象）
          const tmpManifest = {
            ...manifest,
            days: [...(manifest.days || []).filter((d) => d.pickDate !== day.pickDate), day],
          };
          renderToday(tmpManifest);
          return;
        }
      }

      // #/ 默认今日
      renderToday(manifest);
    } catch (err) {
      console.error("[gallery] 渲染失败:", err);
      renderError(err);
    }
  }

  // hash 变化触发路由（首次加载也手动触发）
  window.addEventListener("hashchange", route);
  route();
})();
