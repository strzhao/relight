"use client";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { DailyPick } from "@relight/shared";
import Link from "next/link";
import { useState } from "react";

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

function scoreClass(score: number) {
  if (score >= 8) return "text-score-high";
  if (score >= 6) return "text-score-mid";
  return "text-score-low";
}

function toRoman(n: number): string {
  if (n <= 0) return "";
  const map: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let out = "";
  let rest = n;
  for (const [val, sym] of map) {
    while (rest >= val) {
      out += sym;
      rest -= val;
    }
  }
  return out;
}

interface DailyPickRowProps {
  pick: DailyPick;
  /** 1-based row index, used to render an Issue mark like "Issue II" */
  index: number;
}

export function DailyPickRow({ pick, index }: DailyPickRowProps) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const { day, month, year, weekday } = parsePickDate(pick.pickDate);
  const [whole, frac] = pick.score.toFixed(1).split(".");
  const issueMark = toRoman(index);

  return (
    <li>
      <Link
        href={`/photos/${pick.photoId}`}
        className="group relative grid grid-cols-[5rem_1fr] gap-x-6 py-7 sm:grid-cols-[5.5rem_8rem_1fr] sm:gap-x-7 sm:py-9 lg:grid-cols-[6rem_9rem_1fr_auto] lg:gap-x-9 lg:py-11"
      >
        {/* Thumbnail — square, hairline ring; lifts on hover */}
        <figure className="relative aspect-square w-20 overflow-hidden bg-muted ring-1 ring-foreground/10 transition-all duration-100 group-hover:shadow-[0_18px_42px_-18px_oklch(0.155_0.006_95_/_0.45)] group-hover:ring-foreground/20 sm:w-22 lg:w-24">
          {thumbBroken ? (
            <div className="flex h-full w-full items-center justify-center text-[10px] tracking-[0.22em] text-muted-foreground/70 uppercase">
              No&nbsp;Plate
            </div>
          ) : (
            <img
              src={api.thumbnailUrl(pick.photoId)}
              alt={pick.title}
              loading="lazy"
              onError={() => setThumbBroken(true)}
              className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.04]"
            />
          )}
        </figure>

        {/* Date column — italic display numerals echoing DailyHero's masthead */}
        <div className="hidden flex-col items-start sm:flex">
          <span className="font-display text-[3.4rem] leading-[0.85] font-light italic tabular-nums lg:text-[3.85rem]">
            {day}
          </span>
          <div className="mt-1.5 flex flex-col gap-0.5 text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
            <span className="font-display text-[13px] tracking-wide normal-case italic">
              {month}
            </span>
            <span className="tabular-nums">
              {year} · 周{weekday}
            </span>
          </div>
        </div>

        {/* Compact date for mobile — inline tag instead of stacked masthead */}
        <span className="col-span-1 mb-2 inline-flex items-baseline gap-1.5 text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:hidden">
          <span className="font-display text-base font-light italic">{day}</span>
          <span className="font-display normal-case italic">{month}</span>
          <span className="tabular-nums">{year}</span>
        </span>

        {/* Editorial body — title + narrative */}
        <div className="flex min-w-0 flex-col">
          {/* Issue mark — caps small label, hairline rule beneath */}
          <div className="mb-3 flex items-center gap-3 text-[10px] tracking-[0.24em] text-muted-foreground/80 uppercase">
            <span className="font-display tracking-[0.18em] italic">Issue</span>
            <span className="font-display tracking-wider normal-case italic">{issueMark}</span>
            <span aria-hidden className="h-px flex-1 bg-foreground/12" />
            <span className={cn("inline-flex items-baseline gap-0.5", scoreClass(pick.score))}>
              <span className="font-display text-[1.25rem] leading-none font-light italic tabular-nums">
                {whole}
              </span>
              <span className="font-display text-[10px] italic tabular-nums">.{frac}</span>
            </span>
          </div>

          <h2
            className="font-serif-sc text-[1.6rem] leading-[1.18] font-medium tracking-[-0.012em] text-foreground transition-colors duration-200 group-hover:text-primary lg:text-[1.85rem]"
            style={{ textWrap: "balance" }}
          >
            {pick.title}
          </h2>

          <p
            className="font-serif-sc mt-3 line-clamp-2 max-w-[58ch] text-[0.95rem] leading-[1.7] text-foreground/65 lg:text-[1rem]"
            style={{ textWrap: "pretty" }}
          >
            {pick.narrative}
          </p>
        </div>

        {/* Far-right rail (lg only) — kept thin for visual balance with the date column */}
        <div className="hidden flex-col items-end justify-between pt-1 pb-1 lg:flex">
          <span className="text-[10px] tracking-[0.28em] text-muted-foreground/55 uppercase">
            № {String(index).padStart(3, "0")}
          </span>
          <span
            aria-hidden
            className="font-display text-foreground/15 text-xl italic transition-colors duration-300 group-hover:text-foreground/35"
          >
            →
          </span>
        </div>
      </Link>
    </li>
  );
}
