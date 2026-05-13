"use client";

import type { Photo } from "@relight/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { LightboxProvider, useLightbox } from "./lightbox-context";
import { LightboxControls } from "./lightbox-controls";
import { LightboxImage } from "./lightbox-image";
import { LightboxInfo } from "./lightbox-info";
import { useLightboxKeys } from "./use-lightbox-keys";

export interface LightboxProps {
  open: boolean;
  photos: Photo[];
  initialIndex: number;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

function LightboxInner() {
  useLightboxKeys();
  const { close } = useLightbox();

  const [showInfo, setShowInfo] = useState(false);

  const toggleInfo = useCallback(() => {
    setShowInfo((prev) => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setShowInfo(false);
    close();
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95"
      // biome-ignore lint/a11y/useSemanticElements: 自定义全屏 lightbox，<dialog> 原生 backdrop 行为与设计不符
      role="dialog"
      aria-modal="true"
      aria-label="照片查看器"
    >
      {/* 图片区域 */}
      <LightboxImage />

      {/* 控件（顶部栏 + 翻页箭头） */}
      <LightboxControls showInfo={showInfo} onToggleInfo={toggleInfo} />

      {/* 底部信息面板 */}
      {showInfo && <LightboxInfo />}
    </div>
  );
}

export function Lightbox({
  open,
  photos,
  initialIndex,
  onClose,
  onIndexChange,
  hasMore = false,
  onLoadMore,
}: LightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const savedActiveEl = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRefs = useRef({ onIndexChange, onLoadMore, hasMore });
  callbackRefs.current = { onIndexChange, onLoadMore, hasMore };

  // initialIndex 变化时同步
  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // 焦点管理
  useEffect(() => {
    if (open) {
      savedActiveEl.current = document.activeElement as HTMLElement;
      // 延迟聚焦确保 DOM 已渲染
      requestAnimationFrame(() => {
        containerRef.current?.focus();
      });
    } else {
      // 关闭时恢复焦点
      savedActiveEl.current?.focus();
      savedActiveEl.current = null;
    }
  }, [open]);

  const handleIndexChange = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      callbackRefs.current.onIndexChange?.(index);

      // 翻页联动 loadMore
      const { hasMore: hm, onLoadMore: lm } = callbackRefs.current;
      if (lm && hm && index >= photos.length - 5) {
        lm();
      }
    },
    [photos.length],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <LightboxProvider
      photos={photos}
      currentIndex={currentIndex}
      onIndexChange={handleIndexChange}
      onClose={handleClose}
    >
      <div ref={containerRef} tabIndex={-1} className="outline-none">
        <LightboxInner />
      </div>
    </LightboxProvider>
  );
}
