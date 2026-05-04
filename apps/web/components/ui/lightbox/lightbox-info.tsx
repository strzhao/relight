"use client";

import { api } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import type { Photo } from "@relight/shared";
import { useEffect, useState } from "react";
import { useLightbox } from "./lightbox-context";

export function LightboxInfo() {
  const { currentIndex, photos } = useLightbox();
  const photo = photos[currentIndex];
  const [detail, setDetail] = useState<Photo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!photo) return;

    let cancelled = false;
    setIsLoading(true);
    setError(false);
    setDetail(null);

    api.photos
      .detail(photo.id)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setDetail(res.data);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [photo]);

  if (!photo) return null;

  // 格式化日期
  const effectiveDate = photo.takenAt ?? photo.createdAt;
  const dateStr = effectiveDate
    ? new Date(effectiveDate).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";

  const latestAnalysis = detail?.analyses?.[detail.analyses.length - 1];
  const aestheticScore = latestAnalysis?.aestheticScore;
  const narrative = latestAnalysis?.narrative;

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent px-6 pb-6 pt-16">
      {isLoading ? (
        // 骨架屏
        <div className="space-y-2 animate-pulse">
          <div className="h-4 w-32 rounded bg-white/20" />
          <div className="h-3 w-full rounded bg-white/10" />
          <div className="h-3 w-3/4 rounded bg-white/10" />
          <div className="flex gap-2 mt-2">
            <div className="h-5 w-12 rounded-full bg-white/10" />
            <div className="h-5 w-16 rounded-full bg-white/10" />
            <div className="h-5 w-10 rounded-full bg-white/10" />
          </div>
        </div>
      ) : error ? (
        <p className="text-sm text-white/50">加载信息失败</p>
      ) : (
        <div className="space-y-1.5">
          {/* 日期 + 文件名 */}
          <div className="flex items-center gap-2 text-sm text-white/80">
            {dateStr && <span>{dateStr}</span>}
            {photo.filePath && (
              <span className="text-white/50 text-xs">{photo.filePath.split("/").pop()}</span>
            )}
          </div>

          {/* 叙事描述 */}
          {narrative && (
            <p className="text-sm text-white/90 line-clamp-3 leading-relaxed">{narrative}</p>
          )}

          {/* 美学评分 + 标签 + 文件信息 */}
          <div className="flex flex-wrap items-center gap-2">
            {aestheticScore != null && (
              <span className="text-xs text-white/70">
                美学评分:{" "}
                <span className="font-medium text-white">{aestheticScore.toFixed(1)}</span>
              </span>
            )}

            {detail?.tags && detail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((t) => (
                  <span
                    key={`${t.tagId}-${t.photoId}`}
                    className="inline-flex items-center rounded-full bg-white/15 px-2 py-0.5 text-xs text-white/80"
                  >
                    {t.tagName}
                  </span>
                ))}
              </div>
            )}

            {/* 文件信息 */}
            <span className="text-xs text-white/50">
              {photo.width}×{photo.height}
              {photo.fileSize > 0 && ` · ${formatBytes(photo.fileSize)}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
