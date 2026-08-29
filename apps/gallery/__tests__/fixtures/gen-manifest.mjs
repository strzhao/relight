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
 *   - wallpapers/<date>_v2-contain-default.jpg / -1290x2796.jpg
 *   - videos/<themeKey>.mp4（可播放 mp4，从 fixtures/video-sample.mp4 二进制 copy）
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

// 可播放 mp4 从预生成二进制样本 copy（见 VIDEO_SAMPLE_PATH）。
// 旧 TINY_MP4_HEX 是无帧 ftyp+moov，Chromium 解码报 MEDIA_ERR_SRC_NOT_SUPPORTED(code=4)，
// 导致 video 始终 paused=true，S4.PM1/PM3/PM5 全失败。
function writeTinyMp4(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(VIDEO_SAMPLE_PATH, filePath);
}

/**
 * 生成完整 fixture。
 * @returns {{manifestDir: string, manifestPath: string, manifest: object}}
 */
export function generateFixture() {
  // 清空重建
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

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

    // 占位图
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-thumb.jpg`));
    writeTinyJpeg(path.join(FIXTURE_DIR, "photos", `${photoId}-mid.jpg`));

    const thumbUrl = `photos/${photoId}-thumb.jpg`;
    const midUrl = `photos/${photoId}-mid.jpg`;
    photosToday.push({
      photoId,
      rank,
      title: `今日第 ${rank} 张`,
      narrative: `今日第 ${rank} 张的叙事文案，长度足够通过非空断言。`,
      thumbnail: thumbUrl,
      original: midFailed ? thumbUrl : midUrl, // mid 失败时 original === thumbnail
      takenAt,
      width,
      height,
      faceFocus,
      // 测试辅助标记（蓝队实现不消费这些字段，仅红队 fixture 自省用；JSON.stringify 保留）
      _fixtureFlags: { midFailed, dirtyTakenAt, nullTakenAt, widthZero: width === 0 },
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

  // 壁纸（今日 + 昨日有，前天无）
  const wpTodayLandscape = `wallpapers/${todayStr}_v2-contain-default.jpg`;
  const wpTodayPortrait = `wallpapers/${todayStr}_v2-contain-1290x2796.jpg`;
  const wpYesterdayLandscape = `wallpapers/${yesterdayStr}_v2-contain-default.jpg`;
  const wpYesterdayPortrait = `wallpapers/${yesterdayStr}_v2-contain-1290x2796.jpg`;
  writeTinyJpeg(path.join(FIXTURE_DIR, wpTodayLandscape));
  writeTinyJpeg(path.join(FIXTURE_DIR, wpTodayPortrait));
  writeTinyJpeg(path.join(FIXTURE_DIR, wpYesterdayLandscape));
  writeTinyJpeg(path.join(FIXTURE_DIR, wpYesterdayPortrait));

  // 视频（归属昨日，验 S4 全套 + S14.PM2 深链）
  const videoThemeKey = "trip-2024-summer";
  const videoMp4 = `videos/${videoThemeKey}.mp4`;
  writeTinyMp4(path.join(FIXTURE_DIR, videoMp4));
  // 视频封面
  const videoCover = `videos/${videoThemeKey}-cover.jpg`;
  writeTinyJpeg(path.join(FIXTURE_DIR, videoCover));

  const manifest = {
    generatedAt: new Date().toISOString(),
    days: [
      {
        pickDate: todayStr,
        title: "今日精选",
        narrative: "今日的整体叙事。",
        wallpaperLandscape: wpTodayLandscape,
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
    ],
  };

  const manifestPath = path.join(FIXTURE_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifestDir: FIXTURE_DIR, manifestPath, manifest };
}

// CLI 直接跑：node gen-manifest.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const { manifestDir, manifestPath, manifest } = generateFixture();
  console.log(JSON.stringify({ manifestDir, manifestPath, days: manifest.days.length }, null, 2));
}
