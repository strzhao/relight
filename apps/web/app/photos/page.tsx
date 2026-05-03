"use client";

import { DateViewControl } from "@/components/date-view-control";
import type { DateViewMode } from "@/components/date-view-control";
import { PhotoCard } from "@/components/photo-card";
import { PhotoSectionHeader } from "@/components/photo-section-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePhotosInfinite } from "@/hooks/use-photos-infinite";
import { type GroupedPhotos, groupPhotos, useVirtualGrid } from "@/hooks/use-virtual-grid";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export default function PhotosPage() {
  const [dateViewMode, setDateViewMode] = useState<DateViewMode>("year");
  const [columnCount, setColumnCount] = useState(3);
  const containerRef = useRef<HTMLDivElement>(null);

  // ResizeObserver: 响应式列数计算 (150ms 防抖)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const width = entry.contentRect.width;
        const gap = 8; // gap-2 = 8px
        const minCellSize = 150;
        const cols = Math.max(1, Math.floor((width + gap) / (minCellSize + gap)));
        setColumnCount(cols);
      }, 150);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

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
        <DateViewControl value={dateViewMode} onChange={handleViewModeChange} />
      </div>

      {/* 虚拟滚动容器 */}
      <div ref={containerRef} className="flex-1 overflow-auto px-2">
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            // Sentinel: 底部触发加载更多
            if (virtualItem.index >= flatItems.length) {
              return (
                <div
                  key="sentinel"
                  ref={sentinelRef}
                  className="absolute top-0 left-0 flex w-full items-center justify-center py-4"
                  style={{
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {isFetchingMore && (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  )}
                  {!isFetchingMore && hasMore && (
                    <span className="text-xs text-muted-foreground">上滑加载更多</span>
                  )}
                </div>
              );
            }

            const item = flatItems[virtualItem.index];
            if (!item) return null;

            // 分组标题
            if (item.type === "header") {
              return (
                <div
                  key={`h-${item.groupIndex}`}
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
                key={`r-${item.groupIndex}-${virtualItem.index}`}
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
