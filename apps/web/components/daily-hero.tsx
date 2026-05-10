"use client";

import BannerCarousel, { buildSlides } from "@/components/banner-carousel";
import { Skeleton } from "@/components/ui/skeleton";
import { getTodayPick } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DailyPick } from "@relight/shared";
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
}

function DailyHero({ dailyPick }: DailyHeroProps) {
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
  const isPortrait = photo ? photo.height > photo.width * 1.05 : false;
  const yearsAgo = calcYearsAgo(photo?.takenAt ?? null);

  return (
    <section className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-y-6 overflow-hidden px-5 py-5 md:px-8 lg:flex-row lg:items-stretch lg:gap-x-14 lg:px-10 lg:py-10">
      {/* Banner Carousel — hero + member slides */}
      <figure className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <BannerCarousel slides={buildSlides(pick)} />
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
              <span className="tabular-nums">{`${year} · 周${weekday}`}</span>
            </div>
          </div>
          <div className="flex shrink-0">
            <FolioNav />
          </div>
        </div>

        {/* Years-ago tag — 轻量副标题，仅在 ≥1 年时显示 */}
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
            <span className="font-display italic">{`Vol. ${year}`}</span>
            <span className="h-px w-10 bg-foreground/10" />
            <span className="font-sans font-light tracking-[0.4em]">Relight Chronicle</span>
          </div>
        </div>
      </div>
    </section>
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

// Both named export (for import { DailyHero }) and default export (for mod.default fallback in tests)
export { DailyHero };
export default DailyHero;
