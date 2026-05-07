"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DailyPick, Photo } from "@relight/shared";
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

export function DailyHero() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.daily.today();
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
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {state.status === "loading" ? (
        <HeroFrame variant="loading" />
      ) : state.status === "empty" ? (
        <HeroFrame variant="empty" />
      ) : state.status === "error" ? (
        <HeroFrame variant="error" message={state.message} />
      ) : (
        <HeroContent pick={state.pick} />
      )}
    </div>
  );
}

function HeroContent({ pick }: { pick: DailyPick }) {
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const photo = pick.photo;
  const isVideo = photo && (photo.mediaType ?? "image") === "video";
  const isPortrait = photo ? photo.height > photo.width * 1.05 : false;

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-6 overflow-hidden px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-14 lg:px-10 lg:py-10">
      {/* Photo / Video */}
      <figure className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
        {photo ? (
          isVideo ? (
            <HeroVideo photo={photo} title={pick.title} />
          ) : (
            <img
              src={api.originalUrl(pick.photoId)}
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

      {/* Editorial column */}
      <div
        className={cn(
          "flex min-h-0 w-full flex-col lg:w-[460px] lg:shrink-0",
          isPortrait ? "lg:py-1" : "lg:py-4",
        )}
      >
        {/* Masthead — Date & Nav */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-foreground/15 border-b pb-8">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-[clamp(4rem,10vw,7rem)] leading-[0.8] font-light italic tabular-nums">
              {day}
            </span>
            <div className="flex flex-col gap-0.5 text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
              <span className="font-display text-base tracking-wide normal-case italic">
                {month}
              </span>
              <span className="tabular-nums">
                {year} · 周{weekday}
              </span>
            </div>
          </div>
          <div className="flex shrink-0">
            <FolioNav />
          </div>
        </div>

        {/* Title */}
        <h2
          className="font-serif-sc mt-10 text-[clamp(2.5rem,4.4vw,4.2rem)] leading-[1.05] font-medium tracking-[-0.015em]"
          style={{ textWrap: "balance" }}
        >
          {pick.title}
        </h2>

        {/* Narrative */}
        <p
          className="font-serif-sc mt-8 max-w-[32ch] text-[1.125rem] leading-[1.8] text-foreground/80"
          style={{ textWrap: "pretty" }}
        >
          {pick.narrative}
        </p>

        {/* Footer — Folio & Signature Anchor */}
        <div className="mt-auto flex items-center justify-end gap-4 pt-16 pb-2 text-[10px] tracking-[0.3em] text-muted-foreground/35 uppercase tabular-nums">
          <div className="flex items-center gap-3">
            <span className="font-display italic">Vol. {year}</span>
            <span className="h-px w-10 bg-foreground/10" />
            <span className="font-sans font-light tracking-[0.4em]">Relight Chronicle</span>
          </div>
        </div>
      </div>
    </section>
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
        src={api.thumbnailUrl(photo.id)}
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
        src={api.rawUrl(photo.id)}
        poster={api.thumbnailUrl(photo.id)}
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
