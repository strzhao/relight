"use client";

import { api } from "@/lib/api";
import type { QueueInfo } from "@relight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseQueuesPollReturn {
  queues: QueueInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 5000;

export function useQueuesPoll(): UseQueuesPollReturn {
  const [queues, setQueues] = useState<QueueInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchQueues = useCallback(async () => {
    try {
      const res = await api.queues.list();
      setQueues(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取队列列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchQueues();
  }, [fetchQueues]);

  useEffect(() => {
    // 立即请求一次
    fetchQueues();

    // 每 5 秒轮询
    intervalRef.current = setInterval(fetchQueues, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchQueues]);

  return { queues, loading, error, refresh };
}
