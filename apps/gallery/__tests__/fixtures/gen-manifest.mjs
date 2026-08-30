/**
 * Fixture 工厂：生成 gallery E2E 测试用 manifest.json + 占位图/视频。
 *
 * 设计契约来源（state.md §契约规约 ManifestPhoto + §验收场景 三变体）：
 *   - 三变体显式注入：
 *     ① takenAt=null（S8.PM1 dateline 不渲染）
 *     ② takenAt:"undefined" / ""（S8.PM3 脏字符串）
 *     ③ width=0 / height=0（S9.PM1 fallback aspect-ratio 3/4）
 *     ④ original===thumbnail（S9.PM3 mid 生成失败 fallback）
 *
 * 产物（写入 process.env.GALLERY_FIXTURE_DIR 或默认 /tmp/relight-gallery-fixture）：
 *   - manifest.json（含至少 2 天 + 1 视频 + 1 无壁纸天 + 三变体 photo）
 *   - photos/<id>-thumb.jpg / <id>-mid.jpg（占位 JPEG，可加载）
 *   - wallpapers/<date>_v2-contain-default.jpg / -1290x2796.jpg（非方形：横 8×4 / 竖 4×8）
 *   - videos/<themeKey>.mp4（可播放 mp4，从 fixtures/video-sample.mp4 二进制 copy）
 *
 * 下载验收扩展（2026-08-29 红队，设计 Tier 0 声明，只增不改既有语义）：
 *   A. 壁纸占位图从 1×1 方形改为非方形（横 8×4 / 竖 4×8 最小合法 JPEG，离线 sharp 生成后
 *      base64 内嵌）——满足下载验收场景 5.P3「横版宽>高、竖版高>宽」的文件头解析断言。
 *      manifest URL 字符串不变，既有测试对壁纸仅断言 src 非空（S6.PM2），无尺寸断言。
 *   B. `generateFixture({ missingLinks: true })` 变体：产出独立目录 `${FIXTURE_DIR}-missing`，
 *      manifest 注入缺直链条目（视频 mp4 空串 / 壁纸横版空串 / 照片 original 空串），
 *      满足下载验收场景 11（缺直链不渲染死链下载控件）。默认（无参）行为与产物完全不变。
 *
 * 深链验收扩展（2026-08-30 红队，需求《当前的 url 点击进去后…》DL.V2/V3/V5，只增不改既有语义）：
 *   C. 新增大前天（day-index=3，初始「最新 2 天」挂载之外）4 张 photo + 无壁纸天；
 *      归属该日的深链视频 `trip-deep-history-2021`（id 为合法 UUID → data-video-uuid /
 *      `#/video/<UUID>` 历史聊天链接复活 DL.V3；themeKey 为主推送形态 DL.V2）。
 *   D. 新增未归属日视频 `trip-unmatched-island-2026`（createdAt 日期在 manifest.days 无对应
 *      day → unmatched 区，全部日挂载后才渲染）——DL.V5 深链定位目标。
 *   两者均追加在既有 videos[0]（trip-2024-summer）之后，既有测试对 videos[0] 的依赖不变。
 *
 * 纯 Node，零运行时依赖（JPEG 占位手写最小字节；可播放 mp4 用预生成的二进制样本，
 * 避免 base64 在源码粘贴时损坏，且确保 Chromium 能解码 autoplay 满足 S4 契约）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 预生成可播放 mp4 样本（10 秒 / 160x120 / baseline H.264 / ~3KB），Chromium 能解码并 autoplay。
// 选 10 秒而非 1 秒：S4.PM1 在 scrollIntoView 后 1500ms 检查 paused===false，1 秒视频会播完
// 触发自然 pause；10 秒视频在 1500ms 时仍在播（currentTime≈1.5s），满足断言。
const VIDEO_SAMPLE_PATH = path.join(__dirname, "video-sample.mp4");

const FIXTURE_DIR = process.env.GALLERY_FIXTURE_DIR ?? "/tmp/relight-gallery-fixture";

// 极小 1x1 JPEG（灰）base64 —— 不依赖 sharp，保证工厂零依赖可跑
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3iigoAKKKKACiiigA/9k=";

function writeTinyJpeg(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(TINY_JPEG_B64, "base64"));
}

// 非方形壁纸占位 JPEG（红队下载验收 场景5.P3 方向断言）：横 8×4（宽>高）/ 竖 4×8（高>宽），
// 离线 sharp 一次性生成的最小合法 JPEG，base64 内嵌保持工厂零运行时依赖。
const WP_LANDSCAPE_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAA/9k=";
const WP_PORTRAIT_JPEG_B64 =
  "/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAIAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJAAP//Z";

function writeWallpaperJpeg(filePath, orientation) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const b64 = orientation === "landscape" ? WP_LANDSCAPE_JPEG_B64 : WP_PORTRAIT_JPEG_B64;
  fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
}

// 可播放 mp4 从预生成二进制样本 copy（见 VIDEO_SAMPLE_PATH）。
// 旧 TINY_MP4_HEX 是无帧 ftyp+moov，Chromium 解码报 MEDIA_ERR_SRC_NOT_SUPPORTED(code=4)，
// 导致 video 始终 paused=true，S4.PM1/PM3/PM5 全失败。
function writeTinyMp4(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(VIDEO_SAMPLE_PATH, filePath);
}

/**
 * 生成完整 fixture。
 * @param {{missingLinks?: boolean}} [opts] missingLinks=true 时产出下载验收场景 11 用的
 *   缺直链变体（独立目录，默认产物不受影响）。
 * @returns {{manifestDir: string, manifestPath: string, manifest: object}}
 */
export function generateFixture(opts = {}) {
  const missingLinks = opts?.missingLinks === true;
  const dir = missingLinks ? `${FIXTURE_DIR}-missing` : FIXTURE_DIR;
  // 清空重建
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayStr = iso(today);
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
  const yesterdayStr = iso(yesterday);
  const dayBefore = new Date(today.getTime() - 2 * 24 * 3600 * 1000);
  const dayBeforeStr = iso(dayBefore);

  // 构造今日 20 张 photo（rank 升序），含三变体显式注入
  const photosToday = [];
  for (let rank = 1; rank <= 20; rank++) {
    const photoId = `photo-today-${String(rank).padStart(2, "0")}-${"a1b2c3d4-e5f6-7890-abcd-ef1234567890"}`;
    // 三变体显式注入（rank 5/10/15）
    let takenAt = `2024-07-15T10:${String(rank).padStart(2, "0")}:00.000Z`;
    let width = 4032;
    let height = 3024;
    let midFailed = false;
    let dirtyTakenAt = false;
    let nullTakenAt = false;
    let emptyOriginal = false; // 缺直链变体（场景11.P4）：original 空串 → 照片卡不渲染下载控件
    let faceFocus = null; // 默认无人脸（验 S17.PM2 默认 center）
    if (rank === 3) {
      // 变体 ⑤ faceFocus={0.5,0.26}（S17.PM1/PM3：模拟「那年溪水的温度」中央偏上人脸）
      faceFocus = { x: 0.5, y: 0.26 };
      // 竖图（width<height）触发 cover → object-position 聚焦（S17 契约要求 width<height）
      width = 3024;
      height = 4032;
    }
    if (rank === 12) {
      // 变体 ⑥ faceFocus={0.2,0.8}（验非默认 center，脸在左下角）
      faceFocus = { x: 0.2, y: 0.8 };
      // 竖图（width<height）触发 cover → object-position 聚焦（S17 契约要求 width<height）
      width = 3024;
      height = 4032;
    }
    if (rank === 5) {
      // 变体 ① takenAt=null（S8.PM1）
      takenAt = null;
      nullTakenAt = true;
    }
    if (rank === 10) {
      // 变体 ② takenAt 脏字符串 "undefined"（S8.PM3）
      takenAt = "undefined";
      dirtyTakenAt = true;
    }
    if (rank === 15) {
      // 变体 ③ width=0/height=0（S9.PM1 fallback 3/4）
      width = 0;
      height = 0;
    }
    if (rank === 18) {
      // 变体 ④ mid 失败 fallback original===thumbnail（S9.PM3）
      midFailed = true;
    }
    if (rank === 20 && missingLinks) {
      // 缺直链变体（下载验收场景 11.P4）：original 空串，仅存在于 missingLinks manifest
      emptyOriginal = true;
    }

    // 占位图
    writeTinyJpeg(path.join(dir, "photos", `${photoId}-thumb.jpg`));
    writeTinyJpeg(path.join(dir, "photos", `${photoId}-mid.jpg`));

    const thumbUrl = `photos/${photoId}-thumb.jpg`;
    const midUrl = `photos/${photoId}-mid.jpg`;
    photosToday.push({
      photoId,
      rank,
      title: `今日第 ${rank} 张`,
      narrative: `今日第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: thumbUrl,
      original: emptyOriginal ? "" : midFailed ? thumbUrl : midUrl, // mid 失败时 original === thumbnail
      takenAt,
      width,
      height,
      faceFocus,
      // 测试辅助标记（蓝队实现不消费这些字段，仅红队 fixture 自省用；JSON.stringify 保留）
      _fixtureFlags: {
        midFailed,
        dirtyTakenAt,
        nullTakenAt,
        widthZero: width === 0,
        originalEmpty: emptyOriginal,
      },
    });
  }

  // 昨日 5 张 photo（验跨日 day-index 切换 S2.PM1）
  const photosYesterday = [];
  for (let rank = 1; rank <= 5; rank++) {
    const photoId = `photo-yesterday-${String(rank).padStart(2, "0")}-${"b2c3d4e5-f6a7-8901-bcde-f23456789012"}`;
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-thumb.jpg`));
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-mid.jpg`));
    photosYesterday.push({
      photoId,
      rank,
      title: `昨日第 ${rank} 张`,
      narrative: `昨日第 ${rank} 张叙事。`,
      thumbnail: `photos/${photoId}-thumb.jpg`,
      original: `photos/${photoId}-mid.jpg`,
      takenAt: "2024-06-10T08:00:00.000Z",
      width: 3024,
      height: 4032,
    });
  }

  // 前天 3 张 photo + 无壁纸（验 S7.PM1 无壁纸天流末尾非 wallpaper-card）
  const photosDayBefore = [];
  for (let rank = 1; rank <= 3; rank++) {
    const photoId = `photo-daybefore-${String(rank).padStart(2, "0")}-${"c3d4e5f6-a7b8-9012-cdef-345678901234"}`;
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-thumb.jpg`));
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-mid.jpg`));
    photosDayBefore.push({
      photoId,
      rank,
      title: `前天第 ${rank} 张`,
      narrative: `前天第 ${rank} 张叙事。`,
      thumbnail: `photos/${photoId}-thumb.jpg`,
      original: `photos/${photoId}-mid.jpg`,
      takenAt: "2024-05-01T12:00:00.000Z",
      width: 4000,
      height: 2667,
    });
  }

  // 大前天再多一天（day-index=3，初始「最新 2 天」挂载之外）——深链验收 DL.V2/V3 的目标日。
  // 只增不改：追加在 days 末尾，不影响既有 day-index 0/1/2 的语义与选择器。
  const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 3600 * 1000);
  const threeDaysAgoStr = iso(threeDaysAgo);
  const photosThreeDaysAgo = [];
  for (let rank = 1; rank <= 4; rank++) {
    const photoId = `photo-3days-${String(rank).padStart(2, "0")}-${"d4e5f6a7-b8c9-4012-9def-456789012345"}`;
    writeTinyJpeg(path.join(dir, "photos", `${photoId}-thumb.jpg`));
    writeTinyJpeg(path.join(dir, "photos", `${photoId}-mid.jpg`));
    photosThreeDaysAgo.push({
      photoId,
      rank,
      title: `大前天第 ${rank} 张`,
      narrative: `大前天第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: `photos/${photoId}-thumb.jpg`,
      original: `photos/${photoId}-mid.jpg`,
      takenAt: "2023-10-01T09:00:00.000Z",
      width: 4032,
      height: 3024,
    });
  }

  // 壁纸（今日 + 昨日有，前天无）。非方形占位：横版 8×4 / 竖版 4×8（场景5.P3 方向断言）
  const wpTodayLandscape = `wallpapers/${todayStr}_v2-contain-default.jpg`;
  const wpTodayPortrait = `wallpapers/${todayStr}_v2-contain-1290x2796.jpg`;
  const wpYesterdayLandscape = `wallpapers/${yesterdayStr}_v2-contain-default.jpg`;
  const wpYesterdayPortrait = `wallpapers/${yesterdayStr}_v2-contain-1290x2796.jpg`;
  writeWallpaperJpeg(path.join(dir, wpTodayLandscape), "landscape");
  writeWallpaperJpeg(path.join(dir, wpTodayPortrait), "portrait");
  writeWallpaperJpeg(path.join(dir, wpYesterdayLandscape), "landscape");
  writeWallpaperJpeg(path.join(dir, wpYesterdayPortrait), "portrait");

  // 视频（归属昨日，验 S4 全套 + S14.PM2 深链）
  const videoThemeKey = "trip-2024-summer";
  const videoMp4 = `videos/${videoThemeKey}.mp4`;
  writeTinyMp4(path.join(dir, videoMp4));
  // 视频封面
  const videoCover = `videos/${videoThemeKey}-cover.jpg`;
  writeTinyJpeg(path.join(dir, videoCover));

  // ---------------------------------------------------------------------------
  // 深链验收扩展（2026-08-30 红队，需求《当前的 url 点击进去后…》DL.V2/V3/V5，只增不改）
  //   - deepLinkHistoryVideo：归属大前天（day-index=3，初始 2 天挂载之外）。
  //     id 为合法 UUID（DOM 契约 data-video-uuid / #/video/<UUID> 历史链接复活 DL.V3），
  //     themeKey 为新推送契约形态（#/video/<themeKey> 主路径 DL.V2）。
  //   - deepLinkOrphanVideo：createdAt 归属日（10 天前）在 manifest.days 无对应 day →
  //     unmatched 区（全部日挂载后才渲染）——DL.V5 深链定位目标。
  //   两者均排在既有 videos[0] 之后（既有测试依赖 videos[0] = trip-2024-summer）。
  // ---------------------------------------------------------------------------
  const deepLinkHistoryVideo = {
    id: "3f2b1c4d-5e6f-4a70-8b90-1c2d3e4f5a6b",
    themeKey: "trip-deep-history-2021",
    themeKind: "trip",
    title: "深链历史日视频",
    narrative: "挂在初始未挂载历史日的深链目标视频。",
    mp4: "videos/trip-deep-history-2021.mp4",
    cover: "videos/trip-deep-history-2021-cover.jpg",
    durationSec: 45,
    photoCount: 4,
    createdAt: `${threeDaysAgoStr}T02:00:00.000Z`,
  };
  writeTinyMp4(path.join(dir, deepLinkHistoryVideo.mp4));
  writeTinyJpeg(path.join(dir, deepLinkHistoryVideo.cover));

  const orphanDayStr = iso(new Date(today.getTime() - 10 * 24 * 3600 * 1000));
  const deepLinkOrphanVideo = {
    id: "9a8b7c6d-5e4f-4a30-8b21-0f9e8d7c6b5a",
    themeKey: "trip-unmatched-island-2026",
    themeKind: "trip",
    title: "未归属日深链视频",
    narrative: "归属日无对应 day 的 unmatched 区视频。",
    mp4: "videos/trip-unmatched-island-2026.mp4",
    cover: "videos/trip-unmatched-island-2026-cover.jpg",
    durationSec: 38,
    photoCount: 6,
    createdAt: `${orphanDayStr}T03:00:00.000Z`,
  };
  writeTinyMp4(path.join(dir, deepLinkOrphanVideo.mp4));
  writeTinyJpeg(path.join(dir, deepLinkOrphanVideo.cover));

  // 缺直链变体的第二视频（场景11.P1）：mp4 空串 → 该卡不渲染下载控件。
  // createdAt 晚于正常视频（同日序列后位），保证既有测试 querySelector 命中的首个
  // video 单元仍是正常视频，向后兼容。
  const missingVideo = {
    id: "c0ffee00-1234-4abc-9def-0123456789ab",
    themeKey: "trip-missing-mp4",
    title: "缺直链视频",
    narrative: "缺直链变体视频。",
    mp4: "",
    coverImage: "videos/trip-missing-mp4-cover.jpg",
    durationSec: 60,
    photoCount: 3,
    createdAt: `${yesterdayStr}T04:00:00.000Z`,
  };
  if (missingLinks) {
    writeTinyJpeg(path.join(dir, missingVideo.coverImage));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    days: [
      {
        pickDate: todayStr,
        title: "今日精选",
        narrative: "今日的整体叙事。",
        // 缺直链变体（场景11.P2）：横版空串 → 横版下载入口不渲染；竖版保持非空
        wallpaperLandscape: missingLinks ? "" : wpTodayLandscape,
        wallpaperPortrait: wpTodayPortrait,
        photos: photosToday,
      },
      {
        pickDate: yesterdayStr,
        title: "昨日精选",
        narrative: "昨日的整体叙事。",
        wallpaperLandscape: wpYesterdayLandscape,
        wallpaperPortrait: wpYesterdayPortrait,
        photos: photosYesterday,
      },
      {
        pickDate: dayBeforeStr,
        title: "前天精选",
        narrative: "前天的整体叙事。",
        wallpaperLandscape: null, // 无壁纸天（S7.PM1）
        wallpaperPortrait: null,
        photos: photosDayBefore,
      },
      {
        // 深链目标日（day-index=3，初始「最新 2 天」挂载之外；无壁纸与 fixture 既有无壁纸天同型）
        pickDate: threeDaysAgoStr,
        title: "大前天精选",
        narrative: "大前天的整体叙事。",
        wallpaperLandscape: null,
        wallpaperPortrait: null,
        photos: photosThreeDaysAgo,
      },
    ],
    videos: [
      {
        id: "fixture-video-1",
        themeKey: videoThemeKey,
        themeKind: "trip",
        title: "2024 夏日旅行",
        narrative: "旅行主题视频。",
        mp4: videoMp4,
        cover: videoCover,
        durationSec: 60,
        photoCount: 12,
        // 归属昨日（day-index=1）：今日（流顶）跳过 date-separator 后首单元必须是 rank=1 photo（S1.PM1），
        // 若视频归属今日会插在今日序列首位（date-separator 之后、photo 之前）破坏 S1.PM1。
        // 归属昨日 → 昨日序列 = date-separator → video → photos → wallpaper，
        // video 仍在流内可达（S4 全套 / S14.PM2 深链），且 video 后面紧跟 photo（S4.PM5 ended 后落 photo）。
        createdAt: `${yesterdayStr}T03:00:00.000Z`,
      },
      ...(missingLinks ? [missingVideo] : []),
      deepLinkHistoryVideo,
      deepLinkOrphanVideo,
    ],
  };

  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifestDir: dir, manifestPath, manifest };
}

// CLI 直接跑：node gen-manifest.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const { manifestDir, manifestPath, manifest } = generateFixture();
  console.log(JSON.stringify({ manifestDir, manifestPath, days: manifest.days.length }, null, 2));
}
