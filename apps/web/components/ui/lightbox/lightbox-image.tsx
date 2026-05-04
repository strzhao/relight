"use client";

import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLightbox } from "./lightbox-context";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

export function LightboxImage() {
  const { photos, currentIndex } = useLightbox();
  const photo = photos[currentIndex];

  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const dragStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const prevPhotoId = useRef(photo?.id);

  // 切换照片时重置缩放和平移
  useEffect(() => {
    if (photo?.id !== prevPhotoId.current) {
      prevPhotoId.current = photo?.id;
      setScale(1);
      setTranslate({ x: 0, y: 0 });
      setIsLoading(true);
      setHasError(false);
    }
  }, [photo?.id]);

  // 滚轮缩放
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setScale((prev) => {
        const next = prev + delta;
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      });
      // 缩放低于 1 时重置平移
      setTranslate((prev) => {
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta));
        return nextScale <= 1 ? { x: 0, y: 0 } : prev;
      });
    },
    [scale],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // 双击切换缩放
  const handleDoubleClick = useCallback(() => {
    setScale((prev) => {
      const next = prev > 1.5 ? 1 : 2;
      if (next === 1) {
        setTranslate({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  // 鼠标拖拽（仅 scale > 1 时）
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      translateStart.current = { ...translate };
    },
    [scale, translate],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTranslate({
        x: translateStart.current.x + dx,
        y: translateStart.current.y + dy,
      });
    },
    [isDragging],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleImageLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleImageError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  if (!photo) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* 加载中 Spinner */}
      {isLoading && (
        <div className="absolute z-10 flex items-center justify-center">
          <div className="size-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      )}

      {/* 加载失败 */}
      {hasError && <span className="text-white/60">加载失败</span>}

      <img
        src={`${API_BASE}/api/photos/${photo.id}/original`}
        alt=""
        className={cn("max-h-full max-w-full select-none", isLoading ? "opacity-0" : "opacity-100")}
        style={{
          transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
          cursor: scale > 1 ? (isDragging ? "grabbing" : "grab") : "default",
        }}
        onLoad={handleImageLoad}
        onError={handleImageError}
        draggable={false}
      />
    </div>
  );
}
