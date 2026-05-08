"use client";

import { api } from "@/lib/api";
import type { DailyPick } from "@relight/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";

interface UseDailyPicksInfiniteOptions {
  pageSize?: number;
}

interface State {
  picks: DailyPick[];
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
  | { type: "LOAD_SUCCESS"; picks: DailyPick[]; total: number; page: number; pageSize: number }
  | { type: "LOAD_MORE_SUCCESS"; picks: DailyPick[]; total: number; page: number; pageSize: number }
  | { type: "LOAD_ERROR"; error: string }
  | { type: "RESET" };

const initialState: State = {
  picks: [],
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
      const seenIds = new Set(state.picks.map((p) => p.id));
      const newPicks = action.picks.filter((p) => !seenIds.has(p.id));
      return {
        ...state,
        isLoading: false,
        isFetchingMore: false,
        picks: [...state.picks, ...newPicks],
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

export function useDailyPicksInfinite(options: UseDailyPicksInfiniteOptions = {}) {
  const { pageSize = 20 } = options;
  const [state, dispatch] = useReducer(reducer, initialState);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownUntilRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchPage = useCallback(
    async (page: number) => {
      // api.daily.list 接受 URLSearchParams 实例，与 api.photos.list(obj) 签名不同
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      return api.daily.list(params);
    },
    [pageSize],
  );

  const loadMoreInternal = useRef<() => void>(() => {});
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  loadMoreInternal.current = () => {
    // 加载冷却期: 打断「加载完成 → observer 重建 → 触发加载」级联循环
    // IntersectionObserver 仅在交叉状态变化时触发——sentinel 持续可见时不会重新回调
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

    if (throttleTimer.current) {
      clearTimeout(throttleTimer.current);
    }
    throttleTimer.current = setTimeout(async () => {
      const current = stateRef.current;
      const isFirstPage = current.picks.length === 0;
      dispatch({ type: isFirstPage ? "LOAD_START" : "LOAD_MORE_START" });

      try {
        const nextPage = current.page + 1;
        const result = await fetchPage(nextPage);

        if (!result.success) {
          throw new Error("获取历史精选失败");
        }

        dispatch({
          type: isFirstPage ? "LOAD_SUCCESS" : "LOAD_MORE_SUCCESS",
          picks: result.data,
          total: result.total,
          page: nextPage,
          pageSize,
        });
        cooldownUntilRef.current = Date.now() + 800;
      } catch (err) {
        dispatch({
          type: "LOAD_ERROR",
          error: err instanceof Error ? err.message : "加载历史精选失败",
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
    setTimeout(() => loadMoreInternal.current(), 50);
  }, []);

  useEffect(() => {
    loadMore();
  }, [loadMore]);

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
    picks: state.picks,
    isLoading: state.isLoading,
    isFetchingMore: state.isFetchingMore,
    error: state.error,
    hasMore: state.hasMore,
    total: state.total,
    loadMore,
    reset,
  };
}
