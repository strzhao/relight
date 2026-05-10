import type { DailyPick, Photo } from "@relight/shared";
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
  const smallFs = Math.round(10 * scale);
  const borderWidth = Math.max(1, Math.round(scale));

  const { day, month, year, weekday } = parsePickDate(pick.pickDate);

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
              objectFit: "cover",
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

        {/* Footer folio */}
        <div
          style={{
            marginTop: "auto",
            paddingTop: Math.round(64 * scale),
            paddingBottom: Math.round(8 * scale),
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: Math.round(12 * scale),
          }}
        >
          <span
            style={{
              fontFamily: "'Fraunces', serif",
              fontStyle: "italic",
              fontSize: smallFs,
              color: `${COLOR_MUTED_FOREGROUND}59`,
              letterSpacing: "0.3em",
            }}
          >
            Vol. {year}
          </span>
          <div
            style={{
              height: 1,
              width: Math.round(40 * scale),
              backgroundColor: `${COLOR_FOREGROUND}1A`,
            }}
          />
          <span
            style={{
              fontFamily: "'Noto Serif SC', serif",
              fontWeight: 300,
              fontSize: smallFs,
              color: `${COLOR_MUTED_FOREGROUND}59`,
              letterSpacing: "0.4em",
              textTransform: "uppercase",
            }}
          >
            Relight Chronicle
          </span>
        </div>
      </div>
    </div>
  );
}
