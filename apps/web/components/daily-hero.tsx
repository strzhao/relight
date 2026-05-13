"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { getApiUrl, getTodayPick } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  API_ROUTES,
  type DailyPick,
  type DailyPickEntry,
  type DailyPickMember,
  type Photo,
} from "@relight/shared";
import { Volume2, VolumeX } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "content"; pick: DailyPick };

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

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 计算 takenAt 与今日的年份差。返回正整数；< 1 年返回 null。
 */
function calcYearsAgo(takenAt: string | null): number | null {
  if (!takenAt) return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  const yearDiff = new Date().getFullYear() - taken.getFullYear();
  return yearDiff >= 1 ? yearDiff : null;
}

interface DailyHeroProps {
  dailyPick?: DailyPick | null;
  /** 初始显示的 entry 索引（用于 SSR 测试和 URL query 同步） */
  initialEntryIndex?: number;
}

export function DailyHero({ dailyPick, initialEntryIndex = 0 }: DailyHeroProps) {
  const isControlled = dailyPick !== undefined;
  const [state, setState] = useState<State>(() => {
    if (isControlled) {
      if (!dailyPick) return { status: "empty" };
      const hasEntries = dailyPick.entries && dailyPick.entries.length > 0;
      if (!hasEntries && !dailyPick.photoId) return { status: "empty" };
      return { status: "content", pick: dailyPick };
    }
    return { status: "loading" };
  });

  useEffect(() => {
    if (isControlled) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await getTodayPick();
        if (cancelled) return;
        if (res.success && res.data) {
          const d = res.data;
          const hasEntries = d.entries && d.entries.length > 0;
          const hasPhoto = d.photoId;
          if (!hasEntries && !hasPhoto) {
            setState({ status: "empty" });
          } else {
            setState({ status: "content", pick: d });
          }
        } else {
          setState({ status: "empty" });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "加载失败",
        });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isControlled]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {state.status === "loading" ? (
        <HeroFrame variant="loading" />
      ) : state.status === "empty" ? (
        <HeroFrame variant="empty" />
      ) : state.status === "error" ? (
        <HeroFrame variant="error" message={state.message} />
      ) : (
        <HeroContent pick={state.pick} initialEntryIndex={initialEntryIndex} />
      )}
    </div>
  );
}

function HeroContent({
  pick,
  initialEntryIndex = 0,
}: {
  pick: DailyPick;
  initialEntryIndex?: number;
}) {
  const entries = pick.entries ?? [];

  // 当 entries 为空时回退到旧的单图显示模式
  if (entries.length === 0) {
    return <HeroContentLegacy pick={pick} />;
  }

  return <HeroContentMulti pick={pick} entries={entries} initialIdx={initialEntryIndex} />;
}

/**
 * 旧版单图展示（entries 为空时的兼容路径）
 */
function HeroContentLegacy({ pick }: { pick: DailyPick }) {
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const photo = pick.photo;
  const isVideo = photo && (photo.mediaType ?? "image") === "video";
  const isPortrait = photo ? photo.height > photo.width * 1.05 : false;
  const yearsAgo = calcYearsAgo(photo?.takenAt ?? null);
  const members = pick.members ?? [];

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-6 overflow-hidden px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-14 lg:px-10 lg:py-10">
      <figure className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
        {photo ? (
          isVideo ? (
            <HeroVideo photo={photo} title={pick.title} />
          ) : (
            <img
              src={getApiUrl(API_ROUTES.photos.original(pick.photoId))}
              alt={pick.title}
              className="max-h-full max-w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5"
              style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
            />
          )
        ) : (
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-muted text-muted-foreground">
            照片不可用
          </div>
        )}
      </figure>
      <div
        className={cn(
          "flex min-h-0 w-full flex-col lg:w-[460px] lg:shrink-0",
          isPortrait ? "lg:py-1" : "lg:py-4",
        )}
      >
        <EntryEditorial
          day={day}
          month={month}
          year={year}
          weekday={weekday}
          title={pick.title}
          narrative={pick.narrative}
          yearsAgo={yearsAgo}
        />
        {members.length > 0 && <MemberStrip members={members} />}
        <FolioFooter year={year} />
      </div>
    </section>
  );
}

/**
 * 新版多图展示（entries 有数据时）— banner 轮播 20 entries + 当前 entry 的系列条原地换图
 */
const AUTO_ROTATE_MS = 10_000;
const DRAG_THRESHOLD = 80;

function HeroContentMulti({
  pick,
  entries,
  initialIdx = 0,
}: {
  pick: DailyPick;
  entries: DailyPickEntry[];
  initialIdx?: number;
}) {
  const total = entries.length;
  const isMultiple = total > 1;

  // useSearchParams 在 App Router 之外（如测试 renderToString）会返回 null，安全降级
  const searchParams = useSearchParams();

  // URL ?entry=N 优先于 initialIdx；初次渲染读 URL，后续 setCurrentIdx 同步回 URL
  const [currentIdx, setCurrentIdx] = useState(() => {
    const fromUrl = Number(searchParams?.get("entry") ?? "");
    const seed = Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : initialIdx;
    return Math.min(Math.max(0, seed), total - 1);
  });

  // 当前 entry 内部的子图索引：0 = entry 自身 photo，1+ = members[subIdx-1]
  // entry 切换时（无论自动/手动）必须重置为 0
  const [subIdx, setSubIdx] = useState(0);
  const [leavingIdx, setLeavingIdx] = useState<number | null>(null);

  const currentEntry = entries[currentIdx];
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const yearsAgo = calcYearsAgo(currentEntry?.photo?.takenAt ?? null);

  // ── refs：单一权威 idx，避免 stale closure ──
  const containerRef = useRef<HTMLElement>(null);
  const currentIdxRef = useRef(currentIdx);
  currentIdxRef.current = currentIdx;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const leavingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 同步 URL（不变） ──
  const syncUrl = useCallback((clamped: number) => {
    if (typeof window === "undefined") return;
    try {
      const url = new URL(window.location.href);
      if (clamped === 0) url.searchParams.delete("entry");
      else url.searchParams.set("entry", String(clamped));
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // 非浏览器环境/受限 origin 静默降级
    }
  }, []);

  // ── 切换 entry（核心权威） ──
  const transitionTo = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(0, next), total - 1);
      const prev = currentIdxRef.current;
      if (clamped === prev) return;

      if (leavingTimeoutRef.current) {
        clearTimeout(leavingTimeoutRef.current);
        leavingTimeoutRef.current = null;
      }

      setLeavingIdx(prev);
      setCurrentIdx(clamped);
      currentIdxRef.current = clamped;
      setSubIdx(0); // entry 切换 → 重置子图索引
      syncUrl(clamped);

      leavingTimeoutRef.current = setTimeout(() => {
        setLeavingIdx(null);
        leavingTimeoutRef.current = null;
      }, 600);
    },
    [total, syncUrl],
  );

  const stopInterval = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startInterval = useCallback(() => {
    if (!isMultiple) return;
    stopInterval();
    intervalRef.current = setInterval(() => {
      const next = (currentIdxRef.current + 1) % total;
      transitionTo(next);
    }, AUTO_ROTATE_MS);
  }, [isMultiple, total, stopInterval, transitionTo]);

  // 手动 nav：切换后重置自动计时
  const navGoTo = useCallback(
    (next: number) => {
      transitionTo(next);
      startInterval();
    },
    [transitionTo, startInterval],
  );

  // ── lifecycle：自动轮播 + 键盘 + 可见性切换 ──
  useEffect(() => {
    if (!isMultiple) return;
    startInterval();

    const handleKey = (e: KeyboardEvent) => {
      // focus guard：仅当焦点在容器内时响应（避免输入框被劫持）
      const container = containerRef.current;
      if (container && !container.contains(document.activeElement)) return;
      if (e.key === "ArrowLeft") {
        navGoTo((currentIdxRef.current - 1 + total) % total);
      } else if (e.key === "ArrowRight") {
        navGoTo((currentIdxRef.current + 1) % total);
      }
    };
    const handleVisibility = () => {
      if (document.hidden) stopInterval();
      else startInterval();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stopInterval();
      if (leavingTimeoutRef.current) {
        clearTimeout(leavingTimeoutRef.current);
        leavingTimeoutRef.current = null;
      }
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isMultiple, total, startInterval, stopInterval, navGoTo]);

  // ── pointer/drag ──
  const dragStartX = useRef<number | null>(null);
  const dragDeltaX = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!isMultiple) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    dragStartX.current = e.clientX;
    dragDeltaX.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragStartX.current === null) return;
    const delta = e.clientX - dragStartX.current;
    dragDeltaX.current = delta;
    setDragOffset(delta * 0.4);
  };
  const handlePointerUp = () => {
    if (dragStartX.current === null) return;
    const delta = dragDeltaX.current;
    dragStartX.current = null;
    dragDeltaX.current = 0;
    setDragOffset(0);
    if (delta < -DRAG_THRESHOLD) navGoTo((currentIdxRef.current + 1) % total);
    else if (delta > DRAG_THRESHOLD) navGoTo((currentIdxRef.current - 1 + total) % total);
  };

  if (!currentEntry) return null;

  // 当前实际展示的图（entry 自身或某个 member）+ caption（仅 member 有）
  const subPhoto =
    subIdx === 0
      ? currentEntry.photo
      : (currentEntry.members[subIdx - 1]?.photo ?? currentEntry.photo);
  const subCaption = subIdx > 0 ? (currentEntry.members[subIdx - 1]?.caption ?? "") : "";
  const subPhotoId =
    subIdx === 0
      ? currentEntry.photoId
      : (currentEntry.members[subIdx - 1]?.photoId ?? currentEntry.photoId);
  const isPortrait = subPhoto.height > subPhoto.width * 1.05;

  return (
    <section
      ref={containerRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 容器需要接收键盘事件
      tabIndex={0}
      data-testid="daily-banner"
      aria-roledescription="carousel"
      aria-label="今日精选导览"
      className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-4 overflow-hidden px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-12 lg:px-10 lg:py-8"
      style={{ touchAction: "pan-y" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* 局部样式：交叉淡入 + tick 进度填充 */}
      <style>{`
        .dh-stage { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; align-items: stretch; justify-content: stretch; }
        .dh-image { transition: opacity 600ms cubic-bezier(.22,1,.36,1), transform 600ms cubic-bezier(.22,1,.36,1); will-change: opacity, transform; }
        .dh-caption { animation: dh-cap-in 480ms cubic-bezier(.22,1,.36,1) both; }
        @keyframes dh-cap-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .dh-tick-fill { height: 100%; width: 0; background: currentColor; border-radius: 1px; }
        .dh-tick-fill.is-running { animation: dh-fill 10s linear forwards; }
        @keyframes dh-fill { from { width: 0; } to { width: 100%; } }
        @media (prefers-reduced-motion: reduce) {
          .dh-image, .dh-caption { transition-duration: 0s !important; animation-duration: 0s !important; }
          .dh-tick-fill.is-running { animation-duration: 0s !important; }
        }
      `}</style>

      {/* 左侧：大图（可换 member）+ 系列条 + 轮播控件 */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-y-3 overflow-hidden">
        <div className="dh-stage">
          <EntryBigImage
            key={`${currentIdx}-${subIdx}`}
            photo={subPhoto}
            photoId={subPhotoId}
            alt={subIdx === 0 ? currentEntry.title : subCaption || currentEntry.title}
            caption={subCaption}
            eager={currentIdx === 0 && subIdx === 0}
            dragOffsetPx={dragOffset}
          />
        </div>

        {/* 系列条：仅当当前 entry 有 members 时展示，点击原地换图 */}
        {currentEntry.members.length > 0 && (
          <EntrySeriesStrip
            entry={currentEntry}
            subIdx={subIdx}
            onSelect={(nextSub) => {
              setSubIdx(nextSub);
              // 任何手动切换（含系列内换图）都重置 banner 自动跳转倒计时
              startInterval();
            }}
          />
        )}

        {/* 轮播控件：prev/next + ticks（多 entry 时才显示） */}
        {isMultiple && (
          <>
            <button
              type="button"
              data-testid="banner-arrow-prev"
              aria-label="上一张"
              onClick={() => navGoTo((currentIdx - 1 + total) % total)}
              className="font-display absolute top-1/2 left-2 -translate-y-1/2 text-5xl italic text-foreground/30 transition-colors duration-100 hover:text-foreground/80"
              style={{ lineHeight: 1 }}
            >
              ‹
            </button>
            <button
              type="button"
              data-testid="banner-arrow-next"
              aria-label="下一张"
              onClick={() => navGoTo((currentIdx + 1) % total)}
              className="font-display absolute top-1/2 right-2 -translate-y-1/2 text-5xl italic text-foreground/30 transition-colors duration-100 hover:text-foreground/80"
              style={{ lineHeight: 1 }}
            >
              ›
            </button>

            {/* ticks：每个 entry 一个；当前那个填充进度 */}
            <div
              className="absolute bottom-1 left-1/2 flex -translate-x-1/2 items-center gap-1.5 text-foreground/70"
              role="tablist"
              aria-label="今日精选轮播指示器"
            >
              {entries.map((entry, i) => {
                const isActive = i === currentIdx;
                return (
                  <button
                    key={entry.photoId}
                    type="button"
                    data-testid="banner-tick"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={`跳转到第 ${i + 1} 张`}
                    onClick={() => navGoTo(i)}
                    className="h-0.5 overflow-hidden rounded-sm bg-foreground/20 transition-all duration-200 hover:bg-foreground/50"
                    style={{ width: isActive ? 32 : 16 }}
                  >
                    <span
                      className={`dh-tick-fill${isActive ? " is-running" : ""}`}
                      key={`tick-fill-${i}-${isActive ? "active" : "idle"}`}
                    />
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* 离场前一帧的隐藏 leaving photo（仅用于 cross-fade 视觉占位） */}
        {leavingIdx !== null && false /* 简化：不渲染离场层，靠 key 触发 image 重渲染 */}
      </div>

      {/* 右侧：日期 + 标题 + 叙事 + Folio nav */}
      <div
        className={cn(
          "flex min-h-0 w-full flex-col lg:w-[420px] lg:shrink-0",
          isPortrait ? "lg:py-1" : "lg:py-4",
        )}
      >
        <EntryEditorial
          day={day}
          month={month}
          year={year}
          weekday={weekday}
          title={currentEntry.title}
          narrative={currentEntry.narrative}
          yearsAgo={yearsAgo}
        />
        <FolioFooter year={year} />
      </div>
    </section>
  );
}

// ===== 子组件 =====

/**
 * 大图渲染组件（接受任意 photo —— entry 自身或 member —— 配合 caption 覆盖层做原地换图）
 */
function EntryBigImage({
  photo,
  photoId,
  alt,
  caption = "",
  eager = false,
  dragOffsetPx = 0,
}: {
  photo: Photo;
  photoId: string;
  alt: string;
  /** 仅在显示 member 时有值，作为底部覆盖层 */
  caption?: string;
  /** 首屏首张时 true，提升 LCP */
  eager?: boolean;
  /** 拖拽中的水平偏移像素，由父组件计算 */
  dragOffsetPx?: number;
}) {
  const isVideo = (photo.mediaType ?? "image") === "video";
  const transformStyle =
    dragOffsetPx !== 0 ? { transform: `translateX(${dragOffsetPx}px)` } : undefined;

  return (
    <figure
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center"
      aria-live="polite"
      aria-label={alt}
      data-testid="entry-big-image"
    >
      {isVideo ? (
        <HeroVideo photo={photo} title={alt} />
      ) : (
        <img
          src={getApiUrl(API_ROUTES.photos.original(photoId))}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          draggable={false}
          className="dh-image max-h-full max-w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5"
          style={{ aspectRatio: `${photo.width} / ${photo.height}`, ...(transformStyle ?? {}) }}
        />
      )}
      {caption && (
        <div
          data-testid="entry-big-caption"
          className="dh-caption pointer-events-none absolute right-0 bottom-0 left-0 bg-gradient-to-t from-foreground/55 to-transparent px-5 pt-10 pb-4"
        >
          <p className="font-serif-sc text-sm leading-relaxed text-background/95">{caption}</p>
        </div>
      )}
    </figure>
  );
}

/**
 * 系列缩略条：在大图下方，点击原地切换大图（不跳转）
 * 项 0 = entry 自身 photo，1+ = members[i-1]
 */
function EntrySeriesStrip({
  entry,
  subIdx,
  onSelect,
}: {
  entry: DailyPickEntry;
  subIdx: number;
  onSelect: (nextSub: number) => void;
}) {
  // 第一项始终是 entry 自身 photo（让用户能切回主图）
  const items: { kind: "primary" | "member"; photoId: string; photo: Photo; caption: string }[] = [
    { kind: "primary", photoId: entry.photoId, photo: entry.photo, caption: entry.title },
    ...entry.members.map((m) => ({
      kind: "member" as const,
      photoId: m.photoId,
      photo: m.photo,
      caption: m.caption,
    })),
  ];

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: 容器只负责 ARIA 分组，焦点流转由内部 button 承接
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      data-testid="entry-series-strip"
      // biome-ignore lint/a11y/useSemanticElements: 视觉是横向滚动的图片缩略图列表，<select> 无法承载自定义渲染
      role="listbox"
      aria-label="系列照片"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((item, idx) => {
        const isActive = idx === subIdx;
        const takenYear = item.photo.takenAt ? new Date(item.photo.takenAt).getFullYear() : null;
        return (
          <button
            key={item.photoId}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: listbox 内的 button + role=option 是有意的可点击缩略图
            role="option"
            aria-selected={isActive}
            data-testid="entry-series-thumb"
            data-kind={item.kind}
            title={item.caption}
            onClick={() => onSelect(idx)}
            className={cn(
              "group relative flex-shrink-0 overflow-hidden rounded-sm transition-all duration-150",
              isActive
                ? "ring-2 ring-primary scale-105"
                : "ring-1 ring-foreground/10 hover:ring-foreground/30",
            )}
          >
            <div className="relative h-16 w-16">
              {item.photo.thumbnailPath ? (
                <img
                  src={getApiUrl(API_ROUTES.photos.thumbnail(item.photoId))}
                  alt={item.caption}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-muted text-[9px] text-muted-foreground">
                  无图
                </div>
              )}
              {takenYear !== null && (
                <span className="absolute right-0.5 bottom-0.5 rounded-sm bg-foreground/60 px-0.5 py-0 text-[8px] leading-4 text-background/90 tabular-nums">
                  {takenYear}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 右侧编辑栏：日期 + 标题 + 叙事
 */
function EntryEditorial({
  day,
  month,
  year,
  weekday,
  title,
  narrative,
  yearsAgo,
}: {
  day: string;
  month: string;
  year: string;
  weekday: string;
  title: string;
  narrative: string;
  yearsAgo: number | null;
}) {
  return (
    <>
      {/* Masthead */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-foreground/15 border-b pb-8">
        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-[clamp(4rem,10vw,7rem)] leading-[0.8] font-light italic tabular-nums">
            {day}
          </span>
          <div className="flex flex-col gap-0.5 text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
            <span className="font-display text-base tracking-wide normal-case italic">{month}</span>
            <span className="tabular-nums">
              {year} · 周{weekday}
            </span>
          </div>
        </div>
        <div className="flex shrink-0">
          <FolioNav />
        </div>
      </div>

      {/* Years-ago tag */}
      {yearsAgo !== null && (
        <span
          className="mt-6 self-start text-[11px] tracking-[0.22em] text-primary/80 uppercase tabular-nums"
          data-testid="years-ago-label"
        >
          {`${yearsAgo} 年前的今天`}
        </span>
      )}

      {/* Title */}
      <h2
        className={cn(
          "font-serif-sc text-[clamp(2.5rem,4.4vw,4.2rem)] leading-[1.05] font-medium tracking-[-0.015em]",
          yearsAgo !== null ? "mt-3" : "mt-10",
        )}
        style={{ textWrap: "balance" }}
        data-testid="entry-title"
      >
        {title}
      </h2>

      {/* Narrative */}
      <p
        className="font-serif-sc mt-8 max-w-[32ch] text-[1.125rem] leading-[1.8] text-foreground/80"
        style={{ textWrap: "pretty" }}
        data-testid="entry-narrative"
      >
        {narrative}
      </p>
    </>
  );
}

/**
 * 关联兄弟照片横向滚动条（旧版单图模式用）
 */
function MemberStrip({ members }: { members: DailyPickMember[] }) {
  return (
    <div
      className="mt-8 flex gap-3 overflow-x-auto pb-1"
      data-testid="member-strip"
      style={{ scrollbarWidth: "none" }}
    >
      {members.map((member) => {
        const photo = member.photo;
        const takenYear = photo?.takenAt ? new Date(photo.takenAt).getFullYear() : null;
        return (
          <a
            key={member.photoId}
            href={`/photos/${member.photoId}`}
            className="group flex-shrink-0"
            data-testid="member-thumb"
          >
            <div className="relative h-20 w-20 overflow-hidden rounded-sm ring-1 ring-foreground/10 transition-all duration-100 group-hover:ring-foreground/30">
              {photo?.thumbnailPath ? (
                <img
                  src={getApiUrl(API_ROUTES.photos.thumbnail(member.photoId))}
                  alt={member.caption}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-muted text-[10px] text-muted-foreground">
                  无缩略图
                </div>
              )}
              {takenYear !== null && (
                <span className="absolute right-0.5 bottom-0.5 rounded-sm bg-foreground/60 px-1 py-0 text-[9px] leading-4 text-background/90 tabular-nums">
                  {takenYear}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-[80px] truncate text-[10px] text-muted-foreground">
              {member.caption}
            </p>
          </a>
        );
      })}
    </div>
  );
}

function HeroVideo({ photo, title }: { photo: Photo; title: string }) {
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  if (failed) {
    return (
      <img
        src={getApiUrl(API_ROUTES.photos.thumbnail(photo.id))}
        alt={title}
        className="max-h-full max-w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5"
        style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
      />
    );
  }

  return (
    <div
      className="relative max-h-full max-w-full"
      style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
    >
      <video
        ref={videoRef}
        src={getApiUrl(API_ROUTES.photos.raw(photo.id))}
        poster={getApiUrl(API_ROUTES.photos.thumbnail(photo.id))}
        autoPlay
        loop
        muted={muted}
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        aria-label={title}
        className="block h-full w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5"
      />
      {photo.durationSec ? (
        <span className="absolute top-3 right-3 rounded-sm bg-foreground/45 px-1.5 py-0.5 text-[10px] tracking-wider text-background/95 backdrop-blur-sm tabular-nums">
          {formatDuration(photo.durationSec)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => setMuted((m) => !m)}
        aria-label={muted ? "取消静音" : "静音"}
        className="absolute right-3 bottom-3 flex size-10 items-center justify-center rounded-full bg-foreground/35 text-background backdrop-blur-md transition-all duration-200 hover:bg-foreground/55"
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
    </div>
  );
}

function FolioNav() {
  const items: { href: string; label: string; mark: string }[] = [
    { href: "/photos", label: "Photos", mark: "I" },
    { href: "/history", label: "History", mark: "II" },
    { href: "/admin", label: "Admin", mark: "III" },
  ];
  return (
    <nav className="flex items-baseline pb-1">
      <ul className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-2 text-[11px] tracking-[0.2em] text-muted-foreground uppercase tabular-nums md:gap-x-5">
        {items.map((item) => (
          <li key={item.href} className="group flex items-baseline gap-1.5">
            <span className="font-display text-[10px] text-muted-foreground/40 italic transition-colors group-hover:text-primary">
              {item.mark}
            </span>
            <a
              href={item.href}
              className="text-foreground/70 transition-colors duration-200 hover:text-foreground"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FolioFooter({ year }: { year: string }) {
  return (
    <div className="mt-auto flex items-center justify-end gap-4 pt-16 pb-2 text-[10px] tracking-[0.3em] text-muted-foreground/35 uppercase tabular-nums">
      <div className="flex items-center gap-3">
        <span className="font-display italic">Vol. {year}</span>
        <span className="h-px w-10 bg-foreground/10" />
        <span className="font-sans font-light tracking-[0.4em]">Relight Chronicle</span>
      </div>
    </div>
  );
}

function HeroFrame({
  variant,
  message,
}: {
  variant: "loading" | "empty" | "error";
  message?: string;
}) {
  return (
    <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-6 px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-14 lg:px-10 lg:py-10">
      <figure
        className="relative flex min-h-0 items-center justify-center lg:flex-1"
        style={{ aspectRatio: "3 / 2" }}
      >
        {variant === "loading" ? (
          <Skeleton
            className="h-full max-h-full w-auto rounded-none"
            style={{ aspectRatio: "3 / 2" }}
          />
        ) : (
          <div
            className="flex h-full max-h-full flex-col items-center justify-center gap-2 bg-muted p-8 text-center"
            style={{ aspectRatio: "3 / 2" }}
          >
            <p className="font-serif-sc text-2xl text-foreground/80">
              {variant === "error" ? "加载失败" : "今日精选"}
            </p>
            <p className="text-sm text-muted-foreground">
              {variant === "error"
                ? (message ?? "请稍后再试")
                : "AI 将每日为你挑选最值得回忆的瞬间"}
            </p>
          </div>
        )}
      </figure>
      <div className="flex min-h-0 w-full flex-col lg:w-[480px] lg:shrink-0 lg:py-4">
        <div className="border-foreground/15 border-b pb-8">
          <Skeleton className="h-24 w-64" />
        </div>
        <Skeleton className="mt-10 h-16 w-3/4" />
        <div className="mt-8 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </div>
    </section>
  );
}
