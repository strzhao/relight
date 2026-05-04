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

  // flatItemsRef: 每次渲染同步最新值，供稳定闭包（getItemKey / estimateSize）读取
  const flatItemsRef = useRef(flatItems);
  flatItemsRef.current = flatItems;

  // getItemKey: 为 virtualizer 提供稳定身份，避免 count 变化导致 React reconciliation 失效
  // 零依赖 useCallback — 通过 flatItemsRef.current 读取最新值
  const getItemKey = useCallback((index: number) => {
    const item = flatItemsRef.current[index];
    if (!item) return `__idx_${index}`;
    if (item.type === "header") return `hdr_${item.groupIndex}_${item.label || "unknown"}`;
    const firstPhotoId = item.photoRowPhotos?.[0]?.id ?? "empty";
    return `row_${item.groupIndex}_${firstPhotoId}`;
  }, []);

  // +1 为 sentinel
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => containerRef.current,
    estimateSize: useCallback(
      (index: number) => {
        const item = flatItemsRef.current[index];
        return item?.type === "header" ? headerSize : cellSize;
      },
      [cellSize, headerSize],
    ),
    getItemKey,
    overscan,
  });

  // IntersectionObserver 监听 sentinel 触发加载更多
  // 关键设计：observer 只创建一次，永不因数据变化而销毁重建。
  // 回调通过 ref 读取最新的 hasMore/isFetchingMore/onLoadMore，避免闭包过期。
  // 如果 observer 随 flatItems 变化而销毁重建，新 observer 会因 sentinel
  // 仍在视口内而立即触发 → 形成级联加载循环。
  const sentinelRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef({ hasMore, isFetchingMore, onLoadMore });
  loadMoreRef.current = { hasMore, isFetchingMore, onLoadMore };

  // 当 flatItems 首次从空变为非空时（骨架屏 → 正常视图），创建 observer。
  // 后续 flatItems 因加载更多而变化时，observer 已存在 → 跳过，避免级联。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意通过 ref 读取最新值，避免 observer 销毁重建导致级联加载循环
  useEffect(() => {
    if (observerRef.current) return;
    const sentinel = sentinelRef.current;
    const root = containerRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const { hasMore: hm, isFetchingMore: ifm, onLoadMore: olm } = loadMoreRef.current;
        if (entries[0]?.isIntersecting && hm && !ifm) {
          olm();
        }
      },
      { root, rootMargin: "200px" },
    );

    observer.observe(sentinel);
    observerRef.current = observer;
  }, [flatItems.length]);

  // 组件卸载时断开 observer
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return {
    virtualizer,
    flatItems,
    sentinelRef,
  };
}
