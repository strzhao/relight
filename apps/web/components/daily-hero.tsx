"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DailyPick, Photo } from "@relight/shared";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";

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

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-y-6 px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:justify-center lg:gap-x-14 lg:px-10 lg:py-7">
      {/* Photo — sized to its intrinsic aspect ratio; flex-shrink lets very wide photos still fit */}
      <figure className="relative flex min-h-0 items-center justify-center lg:shrink">
        {photo ? (
          <img
            src={api.thumbnailUrl(pick.photoId)}
            alt={pick.title}
            className="h-full max-h-full w-auto max-w-full object-contain shadow-[0_50px_120px_-30px_oklch(0.155_0.006_95_/_0.55)] ring-1 ring-foreground/5"
            style={{ aspectRatio: `${photo.width} / ${photo.height}` }}
          />
        ) : (
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-muted text-muted-foreground">
            照片不可用
          </div>
        )}
        {isVideo && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex size-24 items-center justify-center rounded-full bg-foreground/30 text-background backdrop-blur-md">
              <Play className="size-11 translate-x-0.5 fill-current" />
            </div>
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

        {/* Masthead II — Score · 今日精选 (twin to the date masthead so the column has two anchors) */}
        <div className="flex items-end justify-between gap-4 pt-5">
          <ScoreMark score={pick.score} />
          <span className="pb-2 text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
            今日精选
          </span>
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

        {/* Metadata ledger — anchored to the column's foot, balancing the masthead at the head */}
        {photo && <MetadataLedger photo={photo} />}
      </div>
    </section>
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
