"use client";

import { cn } from "@/lib/utils";
import { ImageOff } from "lucide-react";
import { useState } from "react";

export interface PhotoGridItem {
  id: string;
  filePath: string;
  thumbnailPath: string | null;
  width: number;
  height: number;
  latestAnalysis: {
    aestheticScore: number | null;
  } | null;
  analysesCount: number;
}

interface PhotoGridProps {
  photos: PhotoGridItem[];
  onPhotoClick: (photoId: string) => void;
}

function ThumbnailImg({
  photoId,
  hasThumbnail,
}: {
  photoId: string;
  hasThumbnail: boolean;
}) {
  const [imgError, setImgError] = useState(false);

  if (!hasThumbnail || imgError) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-muted">
        <ImageOff className="size-8 text-muted-foreground/50" />
      </div>
    );
  }

  return (
    <img
      src={`/api/photos/${photoId}/thumbnail`}
      alt=""
      className="w-full h-full object-cover"
      loading="lazy"
      onError={() => setImgError(true)}
    />
  );
}

export function PhotoGrid({ photos, onPhotoClick }: PhotoGridProps) {
  if (photos.length === 0) {
    return (
      <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
        暂无照片
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {photos.map((photo) => {
        const score = photo.latestAnalysis?.aestheticScore ?? null;
        const isAnalyzed = photo.analysesCount > 0;

        let scoreBadgeClass = "bg-score-low-bg text-score-low";
        if (score != null) {
          if (score >= 8) {
            scoreBadgeClass = "bg-score-high-bg text-score-high";
          } else if (score >= 6) {
            scoreBadgeClass = "bg-score-mid-bg text-score-mid";
          }
        }

        return (
          <button
            key={photo.id}
            type="button"
            onClick={() => onPhotoClick(photo.id)}
            className={cn(
              "group relative rounded-lg border bg-card overflow-hidden text-left transition-all",
              "hover:scale-[1.02] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring",
            )}
          >
            {/* Thumbnail — 动态宽高比，适配横屏/竖屏/方形照片 */}
            <div
              className="relative overflow-hidden"
              style={{ aspectRatio: `${photo.width}/${photo.height}` }}
            >
              <ThumbnailImg photoId={photo.id} hasThumbnail={photo.thumbnailPath != null} />
              {/* Score badge overlay */}
              <div className="absolute bottom-2 left-2">
                {isAnalyzed ? (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold",
                      scoreBadgeClass,
                    )}
                  >
                    {score != null ? score.toFixed(1) : "-"}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs bg-muted text-muted-foreground">
                    未分析
                  </span>
                )}
              </div>
            </div>

            {/* File path */}
            <div className="px-2 py-1.5">
              <p className="truncate text-xs text-muted-foreground font-mono">
                {photo.filePath.split("/").pop() || photo.filePath}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
