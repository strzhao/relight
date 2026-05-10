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
 * 新版多图展示（entries 有数据时）
 */
function HeroContentMulti({
  pick,
  entries,
  initialIdx = 0,
}: {
  pick: DailyPick;
  entries: DailyPickEntry[];
  initialIdx?: number;
}) {
  // useSearchParams 在 App Router 之外（如测试 renderToString）会返回 null，安全降级
  const searchParams = useSearchParams();

  // URL ?entry=N 优先于 initialIdx；初次渲染读 URL，后续 setCurrentIdx 同步回 URL
  const [currentIdx, setCurrentIdx] = useState(() => {
    const fromUrl = Number(searchParams?.get("entry") ?? "");
    const seed = Number.isInteger(fromUrl) && fromUrl > 0 ? fromUrl : initialIdx;
    return Math.min(Math.max(0, seed), entries.length - 1);
  });

  const currentEntry = entries[currentIdx];
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const yearsAgo = calcYearsAgo(currentEntry?.photo?.takenAt ?? null);

  const handleSelectIdx = useCallback(
    (idx: number) => {
      const clamped = Math.min(Math.max(0, idx), entries.length - 1);
      setCurrentIdx(clamped);
      // 同步 URL：rank=0 时省略 query；用 history.replaceState 而非 router.replace，
      // 避免依赖 useRouter（在测试 renderToString / SSR 之外的非 AppRouter 上下文中会抛 invariant）
      if (typeof window === "undefined") return;
      try {
        const url = new URL(window.location.href);
        if (clamped === 0) url.searchParams.delete("entry");
        else url.searchParams.set("entry", String(clamped));
        window.history.replaceState(window.history.state, "", url.toString());
      } catch {
        // 非浏览器环境/受限 origin 静默降级，不影响 UI 切换
      }
    },
    [entries.length],
  );

  // 键盘 ←/→ 切换（走 handleSelectIdx 统一同步 URL）
  const containerRef = useRef<HTMLElement>(null);
  const idxRef = useRef(currentIdx);
  idxRef.current = currentIdx;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        handleSelectIdx(idxRef.current - 1);
      } else if (e.key === "ArrowRight") {
        handleSelectIdx(idxRef.current + 1);
      }
    };
    const el = containerRef.current;
    el?.addEventListener("keydown", handleKeyDown);
    return () => el?.removeEventListener("keydown", handleKeyDown);
  }, [handleSelectIdx]);

  if (!currentEntry) return null;

  const isPortrait = currentEntry.photo.height > currentEntry.photo.width * 1.05;

  return (
    <section
      ref={containerRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 容器需要接收键盘事件
      tabIndex={0}
      aria-label="今日精选导览"
      className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-4 overflow-hidden px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-12 lg:px-10 lg:py-8"
    >
      {/* 左侧：大图 + 系列缩略条 + 20 张栅格 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-y-3 overflow-hidden">
        {/* 大图区 */}
        <EntryBigImage entry={currentEntry} pickTitle={pick.title} eager={currentIdx === 0} />

        {/* 系列缩略条（仅在有系列时显示） */}
        <EntrySeriesStrip members={currentEntry.members} />

        {/* 20 张缩略图栅格 */}
        <EntryThumbGrid entries={entries} currentIdx={currentIdx} onSelect={handleSelectIdx} />
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
 * 大图渲染组件（复用 HeroVideo 视频路径）
 */
function EntryBigImage({
  entry,
  pickTitle,
  eager = false,
}: {
  entry: DailyPickEntry;
  pickTitle: string;
  /** 首屏 rank=0 时设为 true，提升 LCP */
  eager?: boolean;
}) {
  const photo = entry.photo;
  const isVideo = (photo.mediaType ?? "image") === "video";

  return (
    <figure
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center"
      aria-live="polite"
      aria-label={entry.title}
    >
      {isVideo ? (
        <HeroVideo photo={photo} title={entry.title || pickTitle} />
      ) : (
        <img
          src={getApiUrl(API_ROUTES.photos.original(entry.photoId))}
          alt={entry.title}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          className="max-h-full max-w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5 transition-opacity duration-200"
          style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
        />
      )}
    </figure>
  );
}

/**
 * 系列缩略条：仅在有 members 时显示
 */
function EntrySeriesStrip({
  members,
}: {
  members: (DailyPickMember & { photo: Photo })[];
}) {
  if (members.length === 0) return null;

  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      data-testid="entry-series-strip"
      style={{ scrollbarWidth: "none" }}
    >
      {members.map((member, idx) => {
        const photo = member.photo;
        const takenYear = photo.takenAt ? new Date(photo.takenAt).getFullYear() : null;
        return (
          <a
            key={member.photoId}
            href={`/photos/${member.photoId}`}
            className="group flex-shrink-0"
            data-testid="entry-series-thumb"
          >
            <div className="relative h-16 w-16 overflow-hidden rounded-sm ring-1 ring-foreground/10 transition-all duration-100 group-hover:ring-foreground/30">
              {photo.thumbnailPath ? (
                <img
                  src={getApiUrl(API_ROUTES.photos.thumbnail(member.photoId))}
                  alt={member.caption}
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
          </a>
        );
      })}
    </div>
  );
}

/**
 * 20 张缩略图栅格（键盘 + 无障碍）
 */
function EntryThumbGrid({
  entries,
  currentIdx,
  onSelect,
}: {
  entries: DailyPickEntry[];
  currentIdx: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="今日精选照片列表"
      data-testid="entry-thumb-grid"
      className="flex flex-wrap gap-1.5 overflow-y-auto"
      style={{ maxHeight: "9rem" }}
    >
      {entries.map((entry, idx) => {
        const isSelected = idx === currentIdx;
        const photo = entry.photo;
        return (
          <button
            key={entry.photoId}
            type="button"
            role="option"
            aria-selected={isSelected}
            data-testid="entry-thumb"
            onClick={() => onSelect(idx)}
            className={cn(
              "relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-sm ring-1 transition-all duration-200",
              isSelected
                ? "ring-2 ring-primary shadow-sm scale-105"
                : "ring-foreground/10 hover:ring-foreground/30",
            )}
            title={entry.title}
          >
            {photo.thumbnailPath ? (
              <img
                src={getApiUrl(API_ROUTES.photos.thumbnail(entry.photoId))}
                alt={entry.title}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-muted text-[9px] text-muted-foreground">
                无图
              </div>
            )}
            <span className="absolute bottom-0.5 right-0.5 rounded-sm bg-foreground/50 px-0.5 text-[8px] leading-3.5 text-background/90 tabular-nums">
              {idx + 1}
            </span>
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
