"use client";

import { api } from "@/lib/api";
import type { Photo } from "@relight/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";

interface UsePhotosInfiniteOptions {
  pageSize?: number;
  sortBy?: string;
  order?: string;
  tagId?: string;
  storageSourceId?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface State {
  photos: Photo[];
  page: number;
  total: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  error: string | null;
  hasMore: boolean;
}

type Action =
  | { type: "LOAD_START" }
  | { type: "LOAD_MORE_START" }
  | { type: "LOAD_SUCCESS"; photos: Photo[]; total: number; page: number; pageSize: number }
  | { type: "LOAD_MORE_SUCCESS"; photos: Photo[]; total: number; page: number; pageSize: number }
  | { type: "LOAD_ERROR"; error: string }
  | { type: "RESET" };

const initialState: State = {
  photos: [],
  page: 0,
  total: 0,
  isLoading: true,
  isFetchingMore: false,
  error: null,
  hasMore: true,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, isLoading: true, error: null };
    case "LOAD_MORE_START":
      return { ...state, isFetchingMore: true, error: null };
    case "LOAD_SUCCESS":
    case "LOAD_MORE_SUCCESS": {
      const seenIds = new Set(state.photos.map((p) => p.id));
      const newPhotos = action.photos.filter((p) => !seenIds.has(p.id));
      return {
        ...state,
        isLoading: false,
        isFetchingMore: false,
        photos: [...state.photos, ...newPhotos],
        page: action.page,
        total: action.total,
        hasMore: action.page * action.pageSize < action.total,
      };
    }
    case "LOAD_ERROR":
      return {
        ...state,
        isLoading: false,
        isFetchingMore: false,
        error: action.error,
      };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

export function usePhotosInfinite(options: UsePhotosInfiniteOptions = {}) {
  const { pageSize = 50, sortBy, order, tagId, storageSourceId, dateFrom, dateTo } = options;
  const [state, dispatch] = useReducer(reducer, initialState);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownUntilRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchPage = useCallback(
    async (page: number) => {
      return api.photos.list({
        page,
        pageSize,
        sortBy,
        order,
        tagId,
        storageSourceId,
        dateFrom,
        dateTo,
      });
    },
    [pageSize, sortBy, order, tagId, storageSourceId, dateFrom, dateTo],
  );

  const loadMoreInternal = useRef<() => void>(() => {});
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  loadMoreInternal.current = () => {
    // 加载冷却期: 打断「加载完成 → observer 重建 → 触发加载」级联循环
    // IntersectionObserver 仅在交叉状态变化时触发——sentinel 持续可见时不会重新回调。
    // 因此被冷却期阻止后需主动调度重试，避免加载永久卡住。
    if (Date.now() < cooldownUntilRef.current) {
      if (!cooldownTimer.current) {
        cooldownTimer.current = setTimeout(
          () => {
            cooldownTimer.current = null;
            loadMoreInternal.current();
          },
          cooldownUntilRef.current - Date.now() + 50,
        );
      }
      return;
    }

    const s = stateRef.current;
    if (s.isFetchingMore || !s.hasMore) return;

    // 300ms throttle
    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
    }
    throttleTimer.current = setTimeout(async () => {
      const current = stateRef.current;
      const isFirstPage = current.photos.length === 0;
      dispatch({ type: isFirstPage ? "LOAD_START" : "LOAD_MORE_START" });

      try {
        const nextPage = current.page + 1;
        const result = await fetchPage(nextPage);

        if (!result.success) {
          throw new Error("获取照片列表失败");
        }

        dispatch({
          type: isFirstPage ? "LOAD_SUCCESS" : "LOAD_MORE_SUCCESS",
          photos: result.data,
          total: result.total,
          page: nextPage,
          pageSize,
        });
        // 加载成功后设置 800ms 冷却期，防止 sentinel observer 重建后立即触发
        cooldownUntilRef.current = Date.now() + 800;
      } catch (err) {
        dispatch({
          type: "LOAD_ERROR",
          error: err instanceof Error ? err.message : "加载照片失败",
        });
      }
    }, 300);
  };

  const loadMore = useCallback(() => {
    loadMoreInternal.current();
  }, []);

  const reset = useCallback(() => {
    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
      throttleTimer.current = null;
    }
    if (cooldownTimer.current) {
      clearTimeout(cooldownTimer.current);
      cooldownTimer.current = null;
    }
    cooldownUntilRef.current = 0;
    dispatch({ type: "RESET" });
    // 下一帧触发重新加载
    setTimeout(() => loadMoreInternal.current(), 50);
  }, []);

  // 初始加载
  useEffect(() => {
    loadMore();
  }, [loadMore]);

  // 组件卸载时清理 timer
  useEffect(() => {
    return () => {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
      }
      if (cooldownTimer.current) {
        clearTimeout(cooldownTimer.current);
      }
    };
  }, []);

  return {
    photos: state.photos,
    isLoading: state.isLoading,
    isFetchingMore: state.isFetchingMore,
    error: state.error,
    hasMore: state.hasMore,
    loadMore,
    reset,
  };
}
