"use client";

import { BurstSheet } from "@/components/burst-sheet";
import { DateViewControl } from "@/components/date-view-control";
import type { DateViewMode } from "@/components/date-view-control";
import { PhotoCard } from "@/components/photo-card";
import { PhotoSectionHeader } from "@/components/photo-section-header";
import { Button } from "@/components/ui/button";
import { Lightbox } from "@/components/ui/lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { usePhotosInfinite } from "@/hooks/use-photos-infinite";
import { type GroupedPhotos, groupPhotos, useVirtualGrid } from "@/hooks/use-virtual-grid";
import type { Photo } from "@relight/shared";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

function calcGridParams(containerWidth: number) {
  const gap = 8;
  const minCellSize = 150;
  const cols = Math.max(1, Math.floor((containerWidth + gap) / (minCellSize + gap)));
  const cellW = (containerWidth - (cols - 1) * gap) / cols;
  return { cols, cellW };
}

function getInitialContentWidth() {
  if (typeof window === "undefined") return 200;
  return window.innerWidth - 32;
}

export default function PhotosPage() {
  const [mounted, setMounted] = useState(false);
  const [dateViewMode, setDateViewMode] = useState<DateViewMode>("year");
  const [columnCount, setColumnCount] = useState(
    () => calcGridParams(getInitialContentWidth()).cols,
  );
  const [cellSize, setCellSize] = useState(() => calcGridParams(getInitialContentWidth()).cellW);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [burstSheetOpen, setBurstSheetOpen] = useState(false);
  const [burstSheetId, setBurstSheetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ResizeObserver: 响应式列数计算 + cellSize (150ms 防抖)
  // 同时使用 useLayoutEffect 确保首次渲染前获取正确的容器宽度
  const updateGridParams = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const style = getComputedStyle(container);
    const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const { cols, cellW } = calcGridParams(container.clientWidth - padX);
    setColumnCount(cols);
    setCellSize(cellW);
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    updateGridParams();
  }, [updateGridParams]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        updateGridParams();
      }, 150);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [updateGridParams]);

  const { photos, isLoading, isFetchingMore, error, hasMore, loadMore, reset, updatePhoto } =
    usePhotosInfinite();

  // 点击处理：连拍组 → BurstSheet；单图 → Lightbox
  const handlePhotoClick = useCallback(
    (photo: Photo) => {
      if ((photo.burstSize ?? 1) > 1 && photo.burstId) {
        setBurstSheetId(photo.burstId);
        setBurstSheetOpen(true);
      } else {
        const idx = photos.findIndex((p) => p.id === photo.id);
        if (idx !== -1) {
          setLightboxIndex(idx);
          setLightboxOpen(true);
        }
      }
    },
    [photos],
  );

  // BurstSheet 切换代表后，局部更新列表中的代表照片（不 reset 避免丢失滚动位置）
  const handleRepresentativeChanged = useCallback(
    (newRepId: string) => {
      // 找到当前 burst 内所有成员，将其 isBurstRepresentative 更新
      // 遍历 photos，同 burstId 的全部重置，再设新代表
      const burstId = burstSheetId;
      if (!burstId) return;
      for (const p of photos) {
        if (p.burstId === burstId) {
          updatePhoto(p.id, { isBurstRepresentative: p.id === newRepId });
        }
      }
    },
    [burstSheetId, photos, updatePhoto],
  );

  // 切换视图 → 重置滚动位置
  const handleViewModeChange = useCallback((mode: DateViewMode) => {
    setDateViewMode(mode);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, []);

  // 按当前视图模式分组
  const groups = useMemo<GroupedPhotos[]>(
    () => groupPhotos(photos, dateViewMode),
    [photos, dateViewMode],
  );

  const { virtualizer, flatItems, sentinelRef } = useVirtualGrid({
    groups,
    containerRef,
    columnCount,
    hasMore,
    isFetchingMore,
    onLoadMore: loadMore,
    cellSize,
  });

  // 骨架屏 id 列表（依赖 columnCount，与实际列数一致）
  const skeletonIds = useMemo(
    () => Array.from({ length: columnCount * 4 }, (_, i) => `sk-${i}`),
    [columnCount],
  );

  // ====== 状态：加载中 (无缓存数据) ======
  if (isLoading && photos.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-8 text-2xl font-bold">照片库</h1>
        {mounted && (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)` }}
          >
            {skeletonIds.map((id) => (
              <Skeleton key={id} className="aspect-square rounded-md" />
            ))}
          </div>
        )}
      </main>
    );
  }

  // ====== 状态：错误 (无缓存数据) ======
  if (error && photos.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-8 text-2xl font-bold">照片库</h1>
        <div className="flex flex-col items-center gap-4 py-24">
          <p className="text-muted-foreground">{error}</p>
          <Button onClick={reset}>重试</Button>
        </div>
      </main>
    );
  }

  // ====== 状态：空 ======
  if (!isLoading && photos.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold">照片库</h1>
          <DateViewControl value={dateViewMode} onChange={handleViewModeChange} />
        </div>
        <div className="flex flex-col items-center gap-2 py-24">
          <p className="text-muted-foreground">暂无照片</p>
          <Button variant="ghost" onClick={reset}>
            刷新
          </Button>
        </div>
      </main>
    );
  }

  // ====== 正常渲染 ======
  return (
    <main className="flex h-[calc(100dvh-57px)] flex-col">
      {/* 顶部工具栏 */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <h1 className="text-2xl font-bold">照片库</h1>
        <div className="flex items-center gap-2">
          <DateViewControl value={dateViewMode} onChange={handleViewModeChange} />
          <Button
            variant="ghost"
            size="icon"
            onClick={reset}
            disabled={isLoading || isFetchingMore}
            title="刷新"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </div>

      {/* 虚拟滚动容器 */}
      <div ref={containerRef} className="flex-1 overflow-auto px-2 py-3">
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatItems[virtualItem.index];
            if (!item) return null;

            // 分组标题
            if (item.type === "header") {
              return (
                <div
                  key={virtualItem.key}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <PhotoSectionHeader
                    label={item.label ?? ""}
                    count={item.count ?? 0}
                    isFirst={item.groupIndex === 0}
                  />
                </div>
              );
            }

            // 照片行 (网格)
            const gap = 8;
            const cellW =
              columnCount > 0
                ? `calc((100% - ${(columnCount - 1) * gap}px) / ${columnCount})`
                : "100%";
            return (
              <div
                key={virtualItem.key}
                className="absolute top-0 left-0 flex w-full"
                style={{
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                  gap: `${gap}px`,
                }}
              >
                {item.photoRowPhotos?.map((photo) => (
                  <div key={photo.id} style={{ width: cellW, flexShrink: 0 }}>
                    <PhotoCard
                      photo={photo}
                      priority={virtualItem.index < columnCount * 2}
                      onClick={handlePhotoClick}
                    />
                  </div>
                ))}
              </div>
            );
          })}

          {/* Sentinel: 始终渲染在虚拟容器底部，不依赖虚拟器可见范围 */}
          {hasMore && (
            <div
              key="__sentinel__"
              ref={sentinelRef}
              className="absolute top-0 left-0 flex w-full items-center justify-center py-4"
              style={{
                height: "40px",
                transform: `translateY(${virtualizer.getTotalSize()}px)`,
              }}
            >
              {error && photos.length > 0 ? (
                <button
                  type="button"
                  onClick={loadMore}
                  className="flex items-center gap-2 text-sm text-destructive hover:underline"
                >
                  <AlertCircle className="size-4" />
                  加载失败，点击重试
                </button>
              ) : isFetchingMore ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          )}
        </div>

        {/* 底部没有更多提示 */}
        {!hasMore && photos.length > 0 && (
          <div className="py-8 text-center text-xs text-muted-foreground">
            已加载全部 {photos.length} 张照片
          </div>
        )}
      </div>

      {/* Lightbox 照片查看器 */}
      <Lightbox
        open={lightboxOpen}
        photos={photos}
        initialIndex={lightboxIndex}
        onClose={() => setLightboxOpen(false)}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />

      {/* 连拍组底部抽屉 */}
      <BurstSheet
        open={burstSheetOpen}
        burstId={burstSheetId}
        onClose={() => setBurstSheetOpen(false)}
        onRepresentativeChanged={handleRepresentativeChanged}
      />
    </main>
  );
}
