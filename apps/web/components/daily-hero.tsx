"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { getApiUrl, getTodayPick } from "@/lib/api";
import { cn } from "@/lib/utils";
import { API_ROUTES, type DailyPick, type DailyPickMember, type Photo } from "@relight/shared";
import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatMegapixels(w: number, h: number) {
  return `${((w * h) / 1_000_000).toFixed(1)} MP`;
}

function reduceRatio(w: number, h: number) {
  if (!w || !h) return "—";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h);
  return `${w / g} : ${h / g}`;
}

function formatTakenAt(takenAt: string | null) {
  if (!takenAt) return null;
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} · ${hh}:${mm}`;
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 计算 takenAt 与今日（北京时间）的年份差
 * 返回正整数；< 1 年返回 null
 */
function calcYearsAgo(takenAt: string | null): number | null {
  if (!takenAt) return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  const now = new Date();
  const yearDiff = now.getFullYear() - taken.getFullYear();
  return yearDiff >= 1 ? yearDiff : null;
}

interface DailyHeroProps {
  dailyPick?: DailyPick | null;
}

export function DailyHero({ dailyPick }: DailyHeroProps) {
  // 受控模式：外部传入 dailyPick → 直接渲染（用于 SSR / 测试 / RSC 预水合）
  // 非受控模式：未传 prop（dailyPick === undefined）→ 内部 fetch
  const isControlled = dailyPick !== undefined;
  const [state, setState] = useState<State>(() => {
    if (isControlled) {
      return dailyPick ? { status: "content", pick: dailyPick } : { status: "empty" };
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
          setState({ status: "content", pick: res.data });
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

  if (state.status === "loading") return <HeroFrame variant="loading" />;
  if (state.status === "empty") return <HeroFrame variant="empty" />;
  if (state.status === "error") return <HeroFrame variant="error" message={state.message} />;
  return <HeroContent pick={state.pick} />;
}

function HeroContent({ pick }: { pick: DailyPick }) {
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const photo = pick.photo;
  const isVideo = photo && (photo.mediaType ?? "image") === "video";
  const isPortrait = photo ? photo.height > photo.width * 1.05 : false;
  const yearsAgo = calcYearsAgo(photo?.takenAt ?? null);
  const members = pick.members ?? [];

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-6 px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-14 lg:px-10 lg:py-7">
      {/* Photo / Video — fits within the available flex cell preserving aspect ratio (no overflow) */}
      <figure className="relative flex min-h-0 min-w-0 items-center justify-center lg:flex-1">
        {photo ? (
          isVideo ? (
            <HeroVideo photo={photo} title={pick.title} />
          ) : (
            <img
              // 走原图避免缩略图（800px）被放大到视口高度后发糊
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

      {/* Editorial column — fixed width on desktop so the whole spread can center as a unit */}
      <div
        className={cn(
          "flex min-h-0 w-full flex-col overflow-hidden lg:w-[480px] lg:shrink-0",
          isPortrait ? "lg:py-1" : "lg:py-2",
        )}
      >
        {/* Masthead I — Date · Folio */}
        <div className="flex items-end justify-between gap-4 border-foreground/15 border-b pb-4">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-[6.5rem] leading-[0.82] font-light italic tabular-nums">
              {day}
            </span>
            <div className="flex flex-col gap-0.5 pb-2 text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
              <span className="font-display text-base tracking-wide normal-case italic">
                {month}
              </span>
              <span className="tabular-nums">
                {year} · 周{weekday}
              </span>
            </div>
          </div>
          <FolioNav />
        </div>

        {/* Masthead II — Score · 今日精选 · yearsAgo */}
        <div className="flex items-end justify-between gap-4 pt-5">
          <ScoreMark score={pick.score} />
          <div className="flex flex-col items-end gap-1 pb-2">
            <span className="text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
              今日精选
            </span>
            {yearsAgo !== null && (
              <span
                className="text-[11px] tracking-[0.12em] text-primary/80"
                data-testid="years-ago-label"
              >
                {`${yearsAgo} 年前的今天`}
              </span>
            )}
          </div>
        </div>

        {/* Title — display weight, fills the editorial column */}
        <h2
          className="font-serif-sc mt-5 text-[clamp(2.5rem,4.4vw,4rem)] leading-[1.05] font-medium tracking-[-0.018em]"
          style={{ textWrap: "balance" }}
        >
          {pick.title}
        </h2>

        {/* Narrative — readable editorial body */}
        <p
          className="font-serif-sc mt-5 line-clamp-[7] max-w-[34ch] text-[1.0625rem] leading-[1.78] text-foreground/75"
          style={{ textWrap: "pretty" }}
        >
          {pick.narrative}
        </p>

        {/* Member strip — 同期兄弟照片横向滚动 */}
        {members.length > 0 && <MemberStrip members={members} />}

        {/* Metadata ledger — anchored to the column's foot, balancing the masthead at the head */}
        {photo && <MetadataLedger photo={photo} />}
      </div>
    </section>
  );
}

/**
 * 关联兄弟照片横向滚动条
 */
function MemberStrip({ members }: { members: DailyPickMember[] }) {
  return (
    <div
      className="mt-5 flex gap-3 overflow-x-auto pb-1"
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
              {/* 年份角标 */}
              {takenYear !== null && (
                <span className="absolute bottom-0.5 right-0.5 rounded-sm bg-foreground/60 px-1 py-0 text-[9px] leading-4 text-background/90 tabular-nums">
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

  // Some iPhone .MOV files are HEVC-encoded and won't decode in Chrome.
  // Fall back to the still thumbnail so the layout stays intact.
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

  // Wrapper sizes itself as the largest box that fits in the figure while preserving aspect ratio.
  // This isolates the mute button positioning from the figure's letterboxing area.
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

function ScoreMark({ score }: { score: number }) {
  const [whole, frac] = score.toFixed(1).split(".");
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="font-display text-[6.5rem] leading-[0.82] font-light italic tabular-nums">
        {whole}
      </span>
      <div className="flex flex-col gap-0.5 pb-2 text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
        <span className="font-display text-base tracking-wide normal-case italic tabular-nums">
          .{frac}
        </span>
        <span className="tabular-nums">Aesthetic</span>
      </div>
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
    <nav className="flex flex-col items-end gap-1 pb-1 text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
      <span className="text-[9px] tracking-[0.28em] text-muted-foreground/70">— Folio —</span>
      <ul className="flex items-baseline gap-2.5 tabular-nums">
        {items.map((item) => (
          <li key={item.href} className="flex items-baseline gap-1">
            <span className="font-display text-[10px] text-muted-foreground/55 italic">
              {item.mark}
            </span>
            <a
              href={item.href}
              className="text-foreground/80 transition-colors duration-200 hover:text-foreground"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function MetadataLedger({ photo }: { photo: Photo }) {
  const taken = formatTakenAt(photo.takenAt);
  const isVideo = (photo.mediaType ?? "image") === "video";

  const cells: { label: string; value: string }[] = [
    { label: "Captured", value: taken ?? "未知时刻" },
    { label: "Dimensions", value: `${photo.width} × ${photo.height}` },
    { label: "Pixels", value: formatMegapixels(photo.width, photo.height) },
    { label: "Aspect", value: reduceRatio(photo.width, photo.height) },
    { label: "Size", value: formatFileSize(photo.fileSize) },
    { label: "Hash", value: photo.fileHash.slice(0, 8) },
  ];

  if (isVideo) {
    cells.push({
      label: "Runtime",
      value: photo.durationSec ? formatDuration(photo.durationSec) : "—",
    });
    cells.push({ label: "Codec", value: photo.videoCodec ?? "—" });
    cells.push({ label: "FPS", value: photo.videoFps ? photo.videoFps.toFixed(0) : "—" });
  }

  return (
    <dl className="mt-auto grid grid-cols-3 gap-x-5 gap-y-4 border-foreground/15 border-t pt-5 text-foreground/85">
      {cells.map((cell) => (
        <div key={cell.label} className="flex flex-col gap-1">
          <dt className="text-[10.5px] tracking-[0.22em] text-muted-foreground uppercase">
            {cell.label}
          </dt>
          <dd className="font-display text-[1.125rem] leading-tight font-medium tabular-nums">
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
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
    <section className="flex min-h-0 flex-1 flex-col gap-y-6 px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:justify-center lg:gap-x-14 lg:px-10 lg:py-7">
      <figure
        className="relative flex min-h-0 items-center justify-center lg:shrink"
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
      <div className="flex min-h-0 w-full flex-col gap-4 py-4 lg:w-[480px] lg:shrink-0">
        <Skeleton className="h-24 w-48" />
        <Skeleton className="h-24 w-48" />
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <div className="mt-auto grid grid-cols-3 gap-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </div>
    </section>
  );
}
