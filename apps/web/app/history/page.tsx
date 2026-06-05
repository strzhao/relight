"use client";

import { DailyPickRow } from "@/components/daily-pick-row";
import { useDailyPicksInfinite } from "@/hooks/use-daily-picks-infinite";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";

export default function HistoryPage() {
  const { picks, isLoading, isFetchingMore, error, hasMore, total, loadMore, reset } =
    useDailyPicksInfinite({ pageSize: 20 });

  // sentinel 是条件渲染的（只在 list 状态下出现），用 callback ref 而非 useRef
  // 才能保证元素挂载时 observer 才接入、卸载时 observer 也能清理
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (!node) return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              loadMore();
            }
          }
        },
        { rootMargin: "240px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [loadMore],
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const showInitialSkeleton = isLoading && picks.length === 0;
  const showEmpty = !isLoading && !error && !hasMore && picks.length === 0;
  const showError = error && picks.length === 0;

  return (
    <main className="paper-grain mx-auto min-h-screen max-w-5xl px-5 pt-14 pb-32 sm:px-8 sm:pt-20 lg:pt-24">
      {/* Masthead — folio number, title, subtitle, then a hairline rule */}
      <header className="mb-12 sm:mb-16">
        <div className="flex items-baseline justify-between gap-4">
          <Link
            href="/"
            className="text-[10px] tracking-[0.32em] text-muted-foreground uppercase transition-colors duration-200 hover:text-foreground"
          >
            ← Folio
          </Link>
          <span className="text-[10px] tracking-[0.32em] text-muted-foreground/70 uppercase">
            Archive · II
          </span>
        </div>

        <div className="mt-7 flex items-end justify-between gap-6 border-foreground/15 border-b pb-6 sm:pb-8">
          <div className="flex items-baseline gap-4 sm:gap-5">
            <span
              aria-hidden
              className="font-display text-[3.6rem] leading-[0.82] font-light italic tabular-nums text-foreground/85 sm:text-[4.6rem] lg:text-[5.4rem]"
            >
              历
            </span>
            <h1 className="font-serif-sc text-[2.1rem] leading-[1.05] font-medium tracking-[-0.018em] sm:text-[2.6rem] lg:text-[3rem]">
              历史精选
            </h1>
          </div>
          {total > 0 && (
            <div className="hidden flex-col items-end gap-0.5 pb-2 text-[10px] tracking-[0.22em] text-muted-foreground uppercase sm:flex">
              <span className="font-display tracking-wider normal-case italic">Volume</span>
              <span className="font-display text-base font-light italic tabular-nums text-foreground/80">
                {total}
              </span>
            </div>
          )}
        </div>

        <p className="font-serif-sc mt-6 max-w-[52ch] text-[1rem] leading-[1.78] text-foreground/65 sm:text-[1.05rem]">
          AI 每天清晨从你的照片中挑出一张，配以一段叙事——这里是过往所有被记下的瞬间。
        </p>
      </header>

      {/* Body */}
      {showError ? (
        <ErrorState message={error} onRetry={reset} />
      ) : showEmpty ? (
        <EmptyState />
      ) : showInitialSkeleton ? (
        <SkeletonList />
      ) : (
        <ul className="divide-y divide-foreground/10 border-foreground/10 border-y">
          {picks.map((pick, idx) => (
            <DailyPickRow key={pick.id} pick={pick} index={idx + 1} />
          ))}
        </ul>
      )}

      {/* Inline error after data loaded — small banner with retry */}
      {error && picks.length > 0 && (
        <div className="mt-10 flex items-center justify-between gap-4 border-foreground/15 border-y py-4">
          <span className="text-[11px] tracking-[0.22em] text-muted-foreground uppercase">
            Transmission Error · {error}
          </span>
          <button
            type="button"
            onClick={reset}
            className="font-display text-sm italic text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
          >
            重试
          </button>
        </div>
      )}

      {/* Foot — loading more / end-of-folio rule */}
      <FootIndicator
        isFetchingMore={isFetchingMore}
        hasMore={hasMore}
        empty={picks.length === 0}
        sentinelRef={sentinelRef}
      />
    </main>
  );
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-foreground/8 border-foreground/8 border-y">
      {Array.from({ length: 5 }).map((_, i) => (
        // 静态占位列表 — 仅用于初次加载视觉占位，无需 stable id
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
          key={i}
          className="grid grid-cols-1 gap-y-5 py-7 sm:gap-y-6 sm:py-9 lg:grid-cols-[55%_1fr] lg:gap-x-9 lg:gap-y-0 lg:py-11"
        >
          <div
            className="w-auto max-w-full max-h-[28rem] animate-pulse bg-foreground/5"
            style={{ aspectRatio: "1.3333333333333333" }}
          />
          <div className="flex flex-col justify-center gap-3">
            <div className="flex items-center justify-between gap-4">
              <div className="h-5 w-28 animate-pulse bg-foreground/5" />
              <div className="h-4 w-20 animate-pulse bg-foreground/5" />
            </div>
            <div className="h-7 w-3/4 animate-pulse bg-foreground/5" />
            <div className="h-3 w-full animate-pulse bg-foreground/5" />
            <div className="h-3 w-5/6 animate-pulse bg-foreground/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <section className="flex flex-col items-center px-6 py-24 text-center sm:py-32">
      <span className="text-[10px] tracking-[0.36em] text-muted-foreground/70 uppercase">
        — Archive Vacant —
      </span>

      <h2 className="font-serif-sc mt-8 text-[1.7rem] leading-[1.25] font-medium text-foreground/85 sm:text-[2rem]">
        还没有历史精选
      </h2>

      <p className="font-serif-sc mt-5 max-w-[42ch] text-[0.98rem] leading-[1.78] text-foreground/60 sm:text-[1.02rem]">
        每天清晨 6:00，AI 会从你的照片中挑选出当日的精选。一张照片，一段故事，从今天开始累积。
      </p>

      <div
        aria-hidden
        className="mt-10 flex items-center gap-3 text-[10px] tracking-[0.28em] text-muted-foreground/40 uppercase"
      >
        <span className="h-px w-12 bg-foreground/15" />
        <span className="font-display italic">Awaiting</span>
        <span className="h-px w-12 bg-foreground/15" />
      </div>

      <Link
        href="/photos"
        className="font-display mt-10 text-sm italic text-foreground/75 underline-offset-4 transition-colors duration-200 hover:text-foreground hover:underline"
      >
        浏览所有照片
      </Link>
    </section>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="flex flex-col items-center px-6 py-24 text-center sm:py-32">
      <span className="text-[10px] tracking-[0.36em] uppercase text-destructive/80">
        — Transmission Error —
      </span>

      <h2 className="font-serif-sc mt-8 text-[1.7rem] leading-[1.25] font-medium text-foreground/85 sm:text-[2rem]">
        加载失败
      </h2>

      <p className="font-serif-sc mt-5 max-w-[42ch] text-[0.98rem] leading-[1.78] text-foreground/60">
        {message}
      </p>

      <button
        type="button"
        onClick={onRetry}
        className="font-display mt-10 text-sm italic text-foreground underline-offset-4 transition-colors duration-200 hover:underline"
      >
        重试 →
      </button>
    </section>
  );
}

function FootIndicator({
  isFetchingMore,
  hasMore,
  empty,
  sentinelRef,
}: {
  isFetchingMore: boolean;
  hasMore: boolean;
  empty: boolean;
  sentinelRef: (node: HTMLDivElement | null) => void;
}) {
  if (empty) return null;

  if (!hasMore) {
    return (
      <div className="mt-16 flex items-center justify-center gap-3 text-[10px] tracking-[0.32em] text-muted-foreground/70 uppercase">
        <span className="h-px w-16 bg-foreground/12" />
        <span className="font-display italic normal-case">Fin. — End of Folio</span>
        <span className="h-px w-16 bg-foreground/12" />
      </div>
    );
  }

  return (
    <div className="mt-12 flex flex-col items-center gap-4">
      {isFetchingMore && (
        <div className="flex items-center gap-3 text-[10px] tracking-[0.28em] text-muted-foreground uppercase">
          <span className="h-px w-12 bg-foreground/15" />
          <span className="font-display animate-pulse italic normal-case">载入更多</span>
          <span className="h-px w-12 bg-foreground/15" />
        </div>
      )}
      {/* Sentinel — observed by IntersectionObserver to trigger loadMore */}
      <div ref={sentinelRef} className="h-8 w-full" aria-hidden />
    </div>
  );
}
