"use client";

import { ChevronLeft, ChevronRight, Download, Info, X } from "lucide-react";
import { useLightbox } from "./lightbox-context";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface LightboxControlsProps {
  showInfo: boolean;
  onToggleInfo: () => void;
}

const btnClass =
  "rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white transition-colors";

export function LightboxControls({ showInfo, onToggleInfo }: LightboxControlsProps) {
  const { currentIndex, photos, goNext, goPrev, close, canGoNext, canGoPrev } = useLightbox();
  const photo = photos[currentIndex];

  const handleDownload = async () => {
    if (!photo) return;
    try {
      const res = await fetch(`${API_BASE}/api/photos/${photo.id}/original`);
      if (!res.ok) throw new Error("下载失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = photo.filePath.split("/").pop() ?? `photo-${photo.id}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // 静默处理下载失败
    }
  };

  return (
    <>
      {/* 顶部栏 */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-4 py-3">
        {/* 页码 */}
        <span className="text-sm text-white/80">
          {photos.length > 0 ? `${currentIndex + 1} / ${photos.length}` : ""}
        </span>

        {/* 右侧按钮组 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={btnClass}
            onClick={onToggleInfo}
            aria-label={showInfo ? "隐藏信息" : "显示信息"}
          >
            <Info className="size-5" />
          </button>
          <button type="button" className={btnClass} onClick={handleDownload} aria-label="下载">
            <Download className="size-5" />
          </button>
          <button type="button" className={btnClass} onClick={close} aria-label="关闭">
            <X className="size-5" />
          </button>
        </div>
      </div>

      {/* 左翻页按钮 */}
      {canGoPrev && (
        <button
          type="button"
          className={`absolute left-4 top-1/2 -translate-y-1/2 z-20 ${btnClass}`}
          onClick={goPrev}
          aria-label="上一张"
        >
          <ChevronLeft className="size-6" />
        </button>
      )}

      {/* 右翻页按钮 */}
      {canGoNext && (
        <button
          type="button"
          className={`absolute right-4 top-1/2 -translate-y-1/2 z-20 ${btnClass}`}
          onClick={goNext}
          aria-label="下一张"
        >
          <ChevronRight className="size-6" />
        </button>
      )}
    </>
  );
}
