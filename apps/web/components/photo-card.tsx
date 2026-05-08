"use client";

import { formatDuration } from "@/lib/format-duration";
import { cn } from "@/lib/utils";
import type { Photo } from "@relight/shared";
import { ImageOff, Layers, Play } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface PhotoCardProps {
  photo: Photo;
  priority?: boolean;
  onClick?: (photo: Photo) => void;
}

export const PhotoCard = memo(function PhotoCard({
  photo,
  priority = false,
  onClick,
}: PhotoCardProps) {
  const [shouldLoad, setShouldLoad] = useState(priority);
  const [hasError, setHasError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isBurst = (photo.burstSize ?? 1) > 1;

  useEffect(() => {
    if (priority) {
      setShouldLoad(true);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [priority]);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  const handleClick = useCallback(() => {
    onClick?.(photo);
  }, [onClick, photo]);

  if (isBurst) {
    // 连拍组：双层 wrapper（外层 aspect-square 不带 overflow-hidden，内层保留）
    return (
      <div className="relative aspect-square">
        {/* 第三层（最深）：最远的纸片 */}
        <div className="absolute inset-0 translate-x-2.5 translate-y-2.5 rounded-md bg-card border border-border/40 -z-20" />
        {/* 第二层：中间纸片 */}
        <div className="absolute inset-0 translate-x-1 translate-y-1 rounded-md bg-card border border-border/60 -z-10" />
        {/* 顶层：原 PhotoCard 内容（保留 overflow-hidden） */}
        <div
          ref={containerRef}
          className={cn(
            "relative size-full overflow-hidden rounded-md bg-muted",
            onClick && "cursor-pointer hover:opacity-90 transition-opacity",
          )}
          onClick={onClick ? handleClick : undefined}
          role={onClick ? "button" : undefined}
          tabIndex={onClick ? 0 : undefined}
          onKeyDown={
            onClick
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleClick();
                  }
                }
              : undefined
          }
        >
          {shouldLoad && !hasError ? (
            <div className="relative h-full w-full">
              <img
                src={`${API_BASE}/api/photos/${photo.id}/thumbnail`}
                alt={photo.filePath.split("/").pop() ?? photo.id}
                loading={priority ? "eager" : "lazy"}
                className={cn("size-full object-cover")}
                onError={handleError}
              />
              {(photo.mediaType ?? "image") === "video" && (
                <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                  <Play className="size-3" />
                  {formatDuration(photo.durationSec ?? 0)}
                </span>
              )}
              {/* 连拍徽章 */}
              <span className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                <Layers className="size-3" />
                {photo.burstSize}
              </span>
            </div>
          ) : hasError ? (
            <div
              className="flex flex-col items-center justify-center gap-1 size-full text-muted-foreground"
              aria-label="缩略图加载失败"
            >
              <ImageOff className="size-6" />
              <span className="text-xs">加载失败</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // 单图路径：完全保持原有结构
  return (
    <div
      ref={containerRef}
      className={cn(
        "aspect-square relative overflow-hidden rounded-md bg-muted",
        onClick && "cursor-pointer hover:opacity-90 transition-opacity",
      )}
      onClick={onClick ? handleClick : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
    >
      {shouldLoad && !hasError ? (
        <div className="relative h-full w-full">
          <img
            src={`${API_BASE}/api/photos/${photo.id}/thumbnail`}
            alt={photo.filePath.split("/").pop() ?? photo.id}
            loading={priority ? "eager" : "lazy"}
            className={cn("size-full object-cover")}
            onError={handleError}
          />
          {(photo.mediaType ?? "image") === "video" && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
              <Play className="size-3" />
              {formatDuration(photo.durationSec ?? 0)}
            </span>
          )}
        </div>
      ) : hasError ? (
        <div
          className="flex flex-col items-center justify-center gap-1 size-full text-muted-foreground"
          aria-label="缩略图加载失败"
        >
          <ImageOff className="size-6" />
          <span className="text-xs">加载失败</span>
        </div>
      ) : null}
    </div>
  );
});
