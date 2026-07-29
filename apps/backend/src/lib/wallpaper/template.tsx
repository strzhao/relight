import type { DailyPick, Photo } from "@relight/shared";
import { formatPhotoCaptureTime } from "@relight/shared";
import {
  COLOR_BACKGROUND,
  COLOR_BORDER,
  COLOR_FOREGROUND,
  COLOR_MUTED_FOREGROUND,
  COLOR_PHOTO_PLACEHOLDER,
  COLOR_SECONDARY,
} from "./colors";

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const weekdayCN = ["日", "一", "二", "三", "四", "五", "六"];

function parsePickDate(pickDate: string) {
  const [y, m, d] = pickDate.split("-").map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) {
    return { day: pickDate, month: "", year: "", weekday: "" };
  }
  const date = new Date(y, m - 1, d);
  return {
    day: String(d).padStart(2, "0"),
    month: monthNames[m - 1] ?? "",
    year: String(y),
    weekday: weekdayCN[date.getDay()] ?? "",
  };
}

/**
 * 计算 takenAt 与今日的年份差（与 web 端 calcYearsAgo 约定一致）。
 * 返回正整数；< 1 年或无效输入返回 null。
 */
function calcYearsAgo(takenAt: string | null): number | null {
  if (!takenAt) return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  const yearDiff = new Date().getFullYear() - taken.getFullYear();
  return yearDiff >= 1 ? yearDiff : null;
}

export interface DailyHeroJSXOpts {
  pick: Omit<DailyPick, "entries"> & { composedImagePath?: string | null };
  photo: Photo;
  photoDataUrl: string;
  width: number;
  height: number;
}

export function dailyHeroJSX({ pick, photo, photoDataUrl, width, height }: DailyHeroJSXOpts) {
  const W = width;
  const H = height;
  const scale = W / 1800;

  const padding = Math.round(80 * scale);
  const columnWidth = Math.round(460 * scale);
  const gap = Math.round(56 * scale);

  const photoAreaWidth = W - columnWidth - gap - padding * 2;
  const photoAreaHeight = H - padding * 2;

  const dateFs = Math.round(112 * scale);
  const monthFs = Math.round(16 * scale);
  const titleFs = Math.round(60 * scale);
  const narrativeFs = Math.round(18 * scale);
  const borderWidth = Math.max(1, Math.round(scale));

  const { day, month, year, weekday } = parsePickDate(pick.pickDate);

  // 拍摄时刻 dateline（与 web 端格式完全一致，同源 formatPhotoCaptureTime）
  const captureText = formatPhotoCaptureTime(photo.takenAt ?? null);
  const captureYearsAgo = calcYearsAgo(photo.takenAt ?? null);
  const datelineFs = Math.round(13 * scale);

  return (
    <div
      style={{
        display: "flex",
        width: W,
        height: H,
        backgroundColor: COLOR_BACKGROUND,
        fontFamily: "'Fraunces', serif",
        overflow: "hidden",
        padding: `${padding}px`,
        boxSizing: "border-box",
        gap: `${gap}px`,
      }}
    >
      {/* Photo area */}
      <div
        style={{
          display: "flex",
          width: photoAreaWidth,
          height: photoAreaHeight,
          overflow: "hidden",
          backgroundColor: COLOR_BACKGROUND,
          flexShrink: 0,
          flexGrow: 0,
        }}
      >
        {photoDataUrl ? (
          <img
            src={photoDataUrl}
            alt={pick.title}
            width={photoAreaWidth}
            height={photoAreaHeight}
            style={{
              width: photoAreaWidth,
              height: photoAreaHeight,
              objectFit: "contain",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: photoAreaWidth,
              height: photoAreaHeight,
              backgroundColor: COLOR_PHOTO_PLACEHOLDER,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          />
        )}
      </div>

      {/* Editorial column */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: columnWidth,
          height: photoAreaHeight,
          flexShrink: 0,
          flexGrow: 0,
          overflow: "hidden",
        }}
      >
        {/* Masthead — Date */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            borderBottom: `${borderWidth}px solid ${COLOR_BORDER}`,
            paddingBottom: Math.round(32 * scale),
            marginBottom: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: Math.round(10 * scale),
            }}
          >
            {/* Day number */}
            <span
              style={{
                fontFamily: "'Fraunces', serif",
                fontSize: dateFs,
                lineHeight: 0.8,
                fontWeight: 300,
                fontStyle: "italic",
                color: COLOR_FOREGROUND,
                letterSpacing: "-0.02em",
              }}
            >
              {day}
            </span>

            {/* Month / Year / Weekday stack */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: Math.round(2 * scale),
              }}
            >
              <span
                style={{
                  fontFamily: "'Fraunces', serif",
                  fontSize: Math.round(monthFs * 1.1),
                  fontStyle: "italic",
                  fontWeight: 300,
                  color: COLOR_MUTED_FOREGROUND,
                  letterSpacing: "0.02em",
                }}
              >
                {month}
              </span>
              <span
                style={{
                  fontFamily: "'Noto Serif SC', serif",
                  fontSize: monthFs,
                  color: COLOR_MUTED_FOREGROUND,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                }}
              >
                {year} · 周{weekday}
              </span>
            </div>
          </div>
        </div>

        {/* Title */}
        <div
          style={{
            marginTop: Math.round(40 * scale),
            fontFamily: "'Noto Serif SC', serif",
            fontSize: titleFs,
            lineHeight: 1.05,
            fontWeight: 500,
            color: COLOR_FOREGROUND,
            letterSpacing: "-0.015em",
            overflow: "hidden",
            display: "flex",
          }}
        >
          {pick.title}
        </div>

        {/* Narrative */}
        <div
          style={{
            marginTop: Math.round(32 * scale),
            fontFamily: "'Noto Serif SC', serif",
            fontSize: narrativeFs,
            lineHeight: 1.8,
            color: `${COLOR_FOREGROUND}CC`,
            overflow: "hidden",
            display: "flex",
            flexWrap: "wrap",
          }}
        >
          {pick.narrative}
        </div>

        {/* Footer folio — 拍摄时刻印记（最右下方）；takenAt 缺失时留白（不回退品牌） */}
        <div
          style={{
            marginTop: "auto",
            paddingTop: Math.round(64 * scale),
            paddingBottom: Math.round(8 * scale),
            display: "flex",
            alignItems: "baseline",
            justifyContent: "flex-end",
            gap: Math.round(10 * scale),
          }}
        >
          {captureText !== null && (
            <>
              <span
                style={{
                  fontFamily: "'Fraunces', serif",
                  fontStyle: "italic",
                  fontWeight: 300,
                  fontSize: datelineFs,
                  color: `${COLOR_MUTED_FOREGROUND}99`,
                  letterSpacing: "0.04em",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                拍摄于 {captureText}
              </span>
              {captureYearsAgo !== null && (
                <span
                  style={{
                    fontFamily: "'Fraunces', serif",
                    fontStyle: "italic",
                    fontWeight: 300,
                    fontSize: datelineFs,
                    color: `${COLOR_MUTED_FOREGROUND}99`,
                    letterSpacing: "0.04em",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  · {captureYearsAgo} 年前
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 竖版（portrait）壁纸模板 — B 方案（全屏照片 cover + 底部渐变压白字）
//
// 设计文档「排版规格（B 方案）」1290×2796：
//   - 背景照片：sharp 预裁精确 W×H（composer 注入 dataURL），<img width=W height=H> 撑满
//   - 渐变层：absolute bottom, height 1500·scale, linear-gradient 压暗底部
//   - 白字层：absolute bottom, color #F5F1E8, flex column
//     masthead(day/month/yearweek) → title → narrative → dateline
//
// scale = min(W/1290, H/2796) 双轴约束（D4）；横版 scale=W/1800 不动。
// Satori spike 已确认 absolute + linear-gradient 可行（渐变→<linearGradient>+<rect fill=url>）。
// ============================================================================

/** 竖版白字层主色（暖纸白，区别于横版墨色正文） */
const COLOR_PORTRAIT_INK = "#F5F1E8";

export interface PortraitHeroJSXOpts {
  pick: Omit<DailyPick, "entries"> & { composedImagePath?: string | null };
  photo: Photo;
  photoDataUrl: string;
  width: number;
  height: number;
}

export function portraitHeroJSX({ pick, photo, photoDataUrl, width, height }: PortraitHeroJSXOpts) {
  const W = width;
  const H = height;
  // D4: 双轴约束（横版保持 W/1800 不变，此处独立）
  const scale = Math.min(W / 1290, H / 2796);

  const { day, month, year, weekday } = parsePickDate(pick.pickDate);

  // 拍摄时刻 dateline（与横版/web 同源 formatPhotoCaptureTime）
  const captureText = formatPhotoCaptureTime(photo.takenAt ?? null);
  const captureYearsAgo = calcYearsAgo(photo.takenAt ?? null);

  // 排版规格（× scale）
  const dayFs = Math.round(96 * scale);
  const monthFs = Math.round(32 * scale);
  const yearweekFs = Math.round(28 * scale);
  const titleFs = Math.round(76 * scale);
  const narrativeFs = Math.round(32 * scale);
  const datelineFs = Math.round(25 * scale);

  const gradientHeight = Math.round(1500 * scale);
  const padX = Math.round(96 * scale);
  const padBottom = Math.round(110 * scale);
  const mastheadGap = Math.round(30 * scale);
  const titleMarginTop = Math.round(44 * scale);
  const narrativeMarginTop = Math.round(32 * scale);
  const datelineMarginTop = Math.round(56 * scale);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: W,
        height: H,
        position: "relative",
        backgroundColor: "#0A0A0E",
        fontFamily: "'Fraunces', serif",
        overflow: "hidden",
      }}
    >
      {/* 背景照片铺满（composer 已 cover 预裁精确 W×H，img 直接撑满） */}
      {photoDataUrl ? (
        <img
          src={photoDataUrl}
          alt={pick.title}
          width={W}
          height={H}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: W,
            height: H,
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: W,
            height: H,
            backgroundColor: COLOR_PHOTO_PLACEHOLDER,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        />
      )}

      {/* 底部渐变层（压暗以承白字） */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: W,
          height: gradientHeight,
          backgroundImage:
            "linear-gradient(to bottom, rgba(10,10,14,0) 0%, rgba(10,10,14,0.55) 55%, rgba(10,10,14,0.78) 100%)",
        }}
      />

      {/* 白字层（absolute bottom） */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: W,
          color: COLOR_PORTRAIT_INK,
          display: "flex",
          flexDirection: "column",
          padding: `0 ${padX}px ${padBottom}px`,
        }}
      >
        {/* Masthead — day / month / year·week */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: `${mastheadGap}px`,
          }}
        >
          <span
            style={{
              fontFamily: "'Fraunces', serif",
              fontSize: dayFs,
              lineHeight: 0.8,
              fontWeight: 300,
              fontStyle: "italic",
              color: COLOR_PORTRAIT_INK,
              letterSpacing: "-0.02em",
            }}
          >
            {day}
          </span>
          <span
            style={{
              fontFamily: "'Fraunces', serif",
              fontSize: monthFs,
              fontStyle: "italic",
              fontWeight: 300,
              color: COLOR_PORTRAIT_INK,
              opacity: 0.85,
            }}
          >
            {month}
          </span>
          <span
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontSize: yearweekFs,
              color: COLOR_PORTRAIT_INK,
              letterSpacing: "0.2em",
              opacity: 0.75,
            }}
          >
            {year} · 周{weekday}
          </span>
        </div>

        {/* Title */}
        <div
          style={{
            marginTop: `${titleMarginTop}px`,
            fontFamily: "'Noto Serif SC', serif",
            fontSize: titleFs,
            lineHeight: 1.1,
            fontWeight: 500,
            color: COLOR_PORTRAIT_INK,
            letterSpacing: "-0.015em",
            textShadow: "0 2px 20px rgba(0,0,0,0.3)",
            overflow: "hidden",
            display: "flex",
          }}
        >
          {pick.title}
        </div>

        {/* Narrative */}
        <div
          style={{
            marginTop: `${narrativeMarginTop}px`,
            fontFamily: "'Noto Serif SC', serif",
            fontSize: narrativeFs,
            lineHeight: 1.8,
            color: COLOR_PORTRAIT_INK,
            opacity: 0.92,
            overflow: "hidden",
            display: "flex",
            flexWrap: "wrap",
          }}
        >
          {pick.narrative}
        </div>

        {/* Dateline — 拍摄时刻（右对齐）；takenAt 缺失则留白（不渲染该行） */}
        {captureText !== null && (
          <div
            style={{
              marginTop: `${datelineMarginTop}px`,
              display: "flex",
              alignItems: "baseline",
              justifyContent: "flex-end",
              gap: `${Math.round(8 * scale)}px`,
            }}
          >
            <span
              style={{
                fontFamily: "'Fraunces', serif",
                fontStyle: "italic",
                fontWeight: 300,
                fontSize: datelineFs,
                color: COLOR_PORTRAIT_INK,
                opacity: 0.7,
                letterSpacing: "0.04em",
                fontVariantNumeric: "tabular-nums",
                textAlign: "right",
              }}
            >
              拍摄于 {captureText}
              {captureYearsAgo !== null ? ` · ${captureYearsAgo} 年前` : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
