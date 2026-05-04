"use client";

import { DateViewControl } from "@/components/date-view-control";
import type { DateViewMode } from "@/components/date-view-control";
import { PhotoCard } from "@/components/photo-card";
import { PhotoSectionHeader } from "@/components/photo-section-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePhotosInfinite } from "@/hooks/use-photos-infinite";
import { type GroupedPhotos, groupPhotos, useVirtualGrid } from "@/hooks/use-virtual-grid";
import { Loader2, RefreshCw } from "lucide-react";
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
  const [dateViewMode, setDateViewMode] = useState<DateViewMode>("year");
  const [columnCount, setColumnCount] = useState(
    () => calcGridParams(getInitialContentWidth()).cols,
  );
  const [cellSize, setCellSize] = useState(() => calcGridParams(getInitialContentWidth()).cellW);
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

  const { photos, isLoading, isFetchingMore, error, hasMore, loadMore, reset } =
    usePhotosInfinite();

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

  // 骨架屏 id 列表（稳定引用，避免 array index key）
  const skeletonIds = useMemo(() => Array.from({ length: 20 }, (_, i) => `sk-${i}`), []);

  // ====== 状态：加载中 (无缓存数据) ======
  if (isLoading && photos.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-8 text-2xl font-bold">照片库</h1>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {skeletonIds.map((id) => (
            <Skeleton key={id} className="aspect-square rounded-md" />
          ))}
        </div>
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
      <div ref={containerRef} className="flex-1 overflow-auto px-2">
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
                  <PhotoSectionHeader label={item.label ?? ""} count={item.count ?? 0} />
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
                    <PhotoCard photo={photo} priority={virtualItem.index < columnCount * 2} />
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
              {isFetchingMore && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
              {!isFetchingMore && (
                <span className="text-xs text-muted-foreground">上滑加载更多</span>
              )}
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
    </main>
  );
}
