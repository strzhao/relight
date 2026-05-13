"use client";

import { getApiUrl } from "@/lib/api";
import { API_ROUTES, type DailyPick, type Photo } from "@relight/shared";
import { Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Slide =
  | {
      kind: "hero";
      photo: Photo;
      title: string;
      narrative: string;
      yearsAgo: number | null;
    }
  | {
      kind: "member";
      photo: Photo;
      caption: string;
      takenYear: number | null;
    };

// ─── buildSlides ─────────────────────────────────────────────────────────────

function computeYearsAgo(pickDate: string, takenAt: string | null | undefined): number | null {
  if (!takenAt) return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  const [pickYear] = pickDate.split("-").map(Number);
  if (!pickYear) return null;
  const diff = pickYear - taken.getFullYear();
  return diff >= 1 ? diff : null;
}

export function buildSlides(pick: DailyPick): Slide[] {
  const heroPhoto = pick.photo;
  if (!heroPhoto) return [];

  const heroSlide: Slide = {
    kind: "hero",
    // biome-ignore lint/style/noNonNullAssertion: hero photo is guaranteed non-null by daily-selection job
    photo: pick.photo!,
    title: pick.title,
    narrative: pick.narrative,
    yearsAgo: computeYearsAgo(pick.pickDate, pick.photo?.takenAt),
  };
  const members = pick.members ?? [];
  const memberSlides: Slide[] = members
    .filter((m) => m.photo)
    .map((m) => {
      // biome-ignore lint/style/noNonNullAssertion: filtered above
      const photo = m.photo!;
      return {
        kind: "member" as const,
        photo,
        caption: m.caption,
        takenYear: photo.takenAt ? new Date(photo.takenAt).getFullYear() : null,
      };
    });
  return [heroSlide, ...memberSlides];
}

// ─── HeroVideo (internal) ────────────────────────────────────────────────────

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface HeroVideoProps {
  photo: Photo;
  title: string;
  onVideoEl?: (el: HTMLVideoElement | null) => void;
}

export function HeroVideo({ photo, title, onVideoEl }: HeroVideoProps) {
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <img
        src={getApiUrl(API_ROUTES.photos.thumbnail(photo.id))}
        alt={title}
        className="h-full w-full object-cover"
      />
    );
  }

  return (
    <div className="relative h-full w-full">
      <video
        ref={onVideoEl}
        src={getApiUrl(API_ROUTES.photos.raw(photo.id))}
        poster={getApiUrl(API_ROUTES.photos.thumbnail(photo.id))}
        autoPlay
        loop
        muted={muted}
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        aria-label={title}
        className="h-full w-full object-cover"
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

// ─── BannerCarousel ──────────────────────────────────────────────────────────

interface BannerCarouselProps {
  slides: Slide[];
}

const INTERVAL_MS = 10_000;
const DRAG_THRESHOLD = 80;

export default function BannerCarousel({ slides }: BannerCarouselProps) {
  const total = slides.length;
  const isMultiple = total > 1;

  const [currentIdx, setCurrentIdx] = useState(0);
  const [leavingIdx, setLeavingIdx] = useState<number | null>(null);

  // refs — single source of truth for index used by interval / pointer / keyboard handlers
  const containerRef = useRef<HTMLElement | null>(null);
  const currentIdxRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const leavingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);

  // 稳定的 callback ref 工厂 — slides 数量变化时才重建
  const videoRefCallbacks = useMemo(
    () =>
      Array.from({ length: total }, (_, i) => (el: HTMLVideoElement | null) => {
        videoRefs.current[i] = el;
      }),
    [total],
  );

  // drag state
  const dragStartX = useRef<number | null>(null);
  const dragDeltaX = useRef(0);
  const [dragOffset, setDragOffset] = useState(0);

  // ── core transition ──────────────────────────────────────────────────────
  // 单一权威：所有 next/prev 路径都通过 transitionTo，统一更新 currentIdxRef，避免 stale closure

  const transitionTo = useCallback((next: number) => {
    const prev = currentIdxRef.current;
    if (next === prev) return;

    if (leavingTimeoutRef.current) {
      clearTimeout(leavingTimeoutRef.current);
      leavingTimeoutRef.current = null;
    }

    setLeavingIdx(prev);
    setCurrentIdx(next);
    currentIdxRef.current = next;

    const lv = videoRefs.current[prev] ?? null;
    if (lv) lv.pause();
    const ev = videoRefs.current[next] ?? null;
    if (ev) ev.play().catch(() => {});

    leavingTimeoutRef.current = setTimeout(() => {
      setLeavingIdx(null);
      leavingTimeoutRef.current = null;
    }, 800);
  }, []);

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
    }, INTERVAL_MS);
  }, [isMultiple, total, stopInterval, transitionTo]);

  const navGoTo = useCallback(
    (next: number) => {
      transitionTo(next);
      // 重置自动计时：手动 nav 后下一次自动切换距点击 INTERVAL_MS，非剩余时间
      startInterval();
    },
    [transitionTo, startInterval],
  );

  // ── lifecycle ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isMultiple) return;
    startInterval();

    function handleKey(e: KeyboardEvent) {
      // focus guard：仅当焦点在 banner 容器内时响应，避免 input/textarea/搜索框输入时被劫持
      const container = containerRef.current;
      if (container && !container.contains(document.activeElement)) return;

      if (e.key === "ArrowLeft") {
        navGoTo((currentIdxRef.current - 1 + total) % total);
      } else if (e.key === "ArrowRight") {
        navGoTo((currentIdxRef.current + 1) % total);
      }
    }

    function handleVisibility() {
      if (document.hidden) {
        stopInterval();
      } else {
        startInterval();
      }
    }

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

  // ── pointer / drag ───────────────────────────────────────────────────────

  function handlePointerDown(e: React.PointerEvent) {
    if (!isMultiple) return;
    // 控件区域（箭头/ticks 按钮）不进入拖拽路径，否则 setPointerCapture 会吞掉按钮的 click
    if ((e.target as HTMLElement).closest("button")) return;
    dragStartX.current = e.clientX;
    dragDeltaX.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (dragStartX.current === null) return;
    const delta = e.clientX - dragStartX.current;
    dragDeltaX.current = delta;
    setDragOffset(delta * 0.4);
  }

  function handlePointerUp() {
    if (dragStartX.current === null) return;
    const delta = dragDeltaX.current;
    dragStartX.current = null;
    dragDeltaX.current = 0;
    setDragOffset(0);
    if (delta < -DRAG_THRESHOLD) {
      navGoTo((currentIdxRef.current + 1) % total);
    } else if (delta > DRAG_THRESHOLD) {
      navGoTo((currentIdxRef.current - 1 + total) % total);
    }
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Inline styles for transitions */}
      <style>{`
        .bc-slide {
          position: absolute;
          inset: 0;
          opacity: 0;
          transform: scale(1.04);
          transition: opacity 720ms cubic-bezier(0.22,1,0.36,1),
                      transform 720ms cubic-bezier(0.22,1,0.36,1);
          will-change: opacity, transform;
        }
        .bc-slide.is-active {
          opacity: 1;
          transform: scale(1);
        }
        .bc-slide.is-leaving {
          opacity: 0;
          transform: scale(0.98);
        }
        .bc-slide.is-video {
          transform: none;
          transition: opacity 720ms cubic-bezier(0.22,1,0.36,1);
        }
        .bc-slide.is-video.is-active {
          transform: none;
        }
        .bc-slide.is-video.is-leaving {
          transform: none;
        }
        .bc-caption {
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 480ms cubic-bezier(0.22,1,0.36,1) 120ms,
                      transform 480ms cubic-bezier(0.22,1,0.36,1) 120ms;
        }
        .is-active .bc-caption {
          opacity: 1;
          transform: translateY(0);
        }
        .bc-tick-fill {
          height: 100%;
          width: 0;
          background: white;
          border-radius: 1px;
        }
        .bc-tick-fill.is-running {
          animation: bc-fill-progress 10s linear forwards;
        }
        @keyframes bc-fill-progress {
          from { width: 0; }
          to { width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bc-slide,
          .bc-caption {
            transition-duration: 0s !important;
          }
          .bc-tick-fill.is-running {
            animation-duration: 0s !important;
          }
        }
      `}</style>

      <section
        ref={containerRef}
        data-testid="banner-carousel"
        aria-roledescription="carousel"
        aria-label="每日精选与关联回忆"
        tabIndex={isMultiple ? 0 : -1}
        className="relative h-full w-full overflow-hidden bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        style={{ touchAction: "pan-y" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Slides — all kept in DOM for cross-dissolve */}
        {slides.map((slide, i) => {
          const isActive = i === currentIdx;
          const isLeaving = i === leavingIdx;
          const isVideo = slide.photo.mediaType === "video";
          const caption = slide.kind === "member" ? slide.caption : "";
          const hasCaption = caption.length > 0;

          const classes = [
            "bc-slide",
            isVideo ? "is-video" : "",
            isActive ? "is-active" : "",
            isLeaving ? "is-leaving" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div
              key={slide.photo.id}
              data-testid="banner-slide"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA carousel pattern 用 role=group + aria-roledescription="slide"，没有原生 HTML 元素能等价表达
              role="group"
              aria-roledescription="slide"
              aria-label={`第 ${i + 1} 张，共 ${total} 张`}
              aria-current={isActive ? "true" : undefined}
              aria-hidden={isActive ? undefined : "true"}
              className={classes}
              style={
                isActive && dragOffset !== 0
                  ? { transform: `translateX(${dragOffset}px)` }
                  : undefined
              }
            >
              {/* Image or Video */}
              {isVideo ? (
                <HeroVideo
                  photo={slide.photo}
                  title={slide.kind === "hero" ? slide.title : slide.caption}
                  onVideoEl={videoRefCallbacks[i]}
                />
              ) : (
                <img
                  src={getApiUrl(API_ROUTES.photos.original(slide.photo.id))}
                  alt={slide.kind === "hero" ? slide.title : slide.caption}
                  className="h-full w-full object-cover"
                  loading={i === 0 ? "eager" : "lazy"}
                  decoding={i === 0 ? "auto" : "async"}
                  draggable={false}
                />
              )}

              {/* Caption overlay — member slides only */}
              {hasCaption && (
                <div
                  data-testid="banner-caption"
                  className="bc-caption pointer-events-none absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/60 to-transparent px-5 pb-16 pt-12"
                >
                  <p className="font-serif-sc text-sm leading-relaxed text-white/90">{caption}</p>
                  {slide.kind === "member" && slide.takenYear !== null && (
                    <p className="mt-1 text-[11px] tracking-[0.18em] text-white/60 tabular-nums uppercase">
                      {String(slide.takenYear)}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Controls — only when multiple slides */}
        {isMultiple && (
          <>
            {/* Prev arrow */}
            <button
              type="button"
              data-testid="banner-arrow-prev"
              aria-label="上一张"
              onClick={() => navGoTo((currentIdx - 1 + total) % total)}
              className="font-display absolute top-1/2 left-6 -translate-y-1/2 text-5xl italic text-white/40 transition-opacity duration-100 hover:text-white/100"
              style={{ lineHeight: 1 }}
            >
              ‹
            </button>

            {/* Next arrow */}
            <button
              type="button"
              data-testid="banner-arrow-next"
              aria-label="下一张"
              onClick={() => navGoTo((currentIdx + 1) % total)}
              className="font-display absolute top-1/2 right-6 -translate-y-1/2 text-5xl italic text-white/40 transition-opacity duration-100 hover:text-white/100"
              style={{ lineHeight: 1 }}
            >
              ›
            </button>

            {/* Ticks — 容器不加 aria-hidden，因为内含可交互的跳转按钮（B#4）；按钮各自有 aria-label */}
            <div className="absolute bottom-[22px] left-1/2 flex -translate-x-1/2 items-center gap-2">
              {slides.map((slide, i) => {
                const isActive = i === currentIdx;
                return (
                  <button
                    key={slide.photo.id}
                    type="button"
                    data-testid="banner-tick"
                    onClick={() => navGoTo(i)}
                    className="h-0.5 overflow-hidden rounded-sm bg-white/35 transition-all duration-200 hover:bg-white/70"
                    style={{ width: isActive ? 40 : 24 }}
                    aria-label={`跳转到第 ${i + 1} 张`}
                  >
                    <span
                      className={`bc-tick-fill${isActive ? " is-running" : ""}`}
                      key={`tick-fill-${i}-${isActive ? currentIdx : "idle"}`}
                    />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>
    </>
  );
}
