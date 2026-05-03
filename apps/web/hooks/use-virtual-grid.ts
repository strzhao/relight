"use client";

import type { Photo } from "@relight/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef } from "react";

export type DateViewMode = "year" | "month" | "day";

export interface GroupedPhotos {
  label: string;
  photos: Photo[];
}

export interface FlatItem {
  type: "header" | "photoRow";
  groupIndex: number;
  label?: string;
  count?: number;
  photoRowPhotos?: Photo[];
}

interface UseVirtualGridOptions {
  groups: GroupedPhotos[];
  containerRef: React.RefObject<HTMLElement | null>;
  columnCount: number;
  hasMore: boolean;
  isFetchingMore: boolean;
  onLoadMore: () => void;
  cellSize?: number;
  headerSize?: number;
  overscan?: number;
}

/**
 * 按视图模式对照片进行分组
 * - 年: 2026年
 * - 月: 2026年5月
 * - 日: 2026年5月3日
 */
export function groupPhotos(photos: Photo[], mode: DateViewMode): GroupedPhotos[] {
  const groups = new Map<string, Photo[]>();

  for (const photo of photos) {
    const effectiveDate = photo.takenAt ?? photo.createdAt;
    const date = new Date(effectiveDate);
    let key: string;

    switch (mode) {
      case "year":
        key = `${date.getFullYear()}年`;
        break;
      case "month":
        key = `${date.getFullYear()}年${date.getMonth() + 1}月`;
        break;
      default:
        key = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
        break;
    }

    const existing = groups.get(key);
    if (existing) {
      existing.push(photo);
    } else {
      groups.set(key, [photo]);
    }
  }

  return Array.from(groups.entries()).map(([label, list]) => ({
    label,
    photos: list,
  }));
}

export function useVirtualGrid(options: UseVirtualGridOptions) {
  const {
    groups,
    containerRef,
    columnCount,
    hasMore,
    isFetchingMore,
    onLoadMore,
    cellSize = 200,
    headerSize = 40,
    overscan = 5,
  } = options;

  // 将分组展平为虚拟列表项: 每个 group -> 1 header + N 行照片
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    const cols = Math.max(1, columnCount);

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group) continue;
      items.push({
        type: "header",
        groupIndex: i,
        label: group.label,
        count: group.photos.length,
      });

      const numRows = Math.ceil(group.photos.length / cols);
      for (let r = 0; r < numRows; r++) {
        const start = r * cols;
        items.push({
          type: "photoRow",
          groupIndex: i,
          photoRowPhotos: group.photos.slice(start, start + cols),
        });
      }
    }
    return items;
  }, [groups, columnCount]);

  // +1 为 sentinel
  const virtualizer = useVirtualizer({
    count: flatItems.length + (hasMore ? 1 : 0),
    getScrollElement: () => containerRef.current,
    estimateSize: useCallback(
      (index: number) => {
        if (index >= flatItems.length) return headerSize; // sentinel
        const item = flatItems[index];
        return item?.type === "header" ? headerSize : cellSize;
      },
      [flatItems, cellSize, headerSize],
    ),
    overscan,
  });

  // IntersectionObserver 监听 sentinel 触发加载更多
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isFetchingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMore();
        }
      },
      {
        root: containerRef.current,
        rootMargin: "200px",
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, onLoadMore, containerRef]);

  return {
    virtualizer,
    flatItems,
    sentinelRef,
  };
}
