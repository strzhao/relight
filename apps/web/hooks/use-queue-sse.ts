"use client";

import type { QueueSnapshot } from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseQueueSSEReturn {
  snapshot: QueueSnapshot | null;
  error: string | null;
  reconnect: () => void;
}

export function useQueueSSE(queueName: string): UseQueueSSEReturn {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    // 关闭已有连接
    esRef.current?.close();

    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
    const url = `${baseUrl}${API_ROUTES.queues.events(queueName)}`;
    const es = new EventSource(url);

    es.addEventListener("snapshot", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as QueueSnapshot;
        setSnapshot(data);
        setError(null);
      } catch {
        // 解析失败忽略
      }
    });

    es.addEventListener("error", () => {
      setError("SSE 连接失败，正在重连...");
    });

    es.onerror = () => {
      setError("SSE 连接失败，正在重连...");
    };

    esRef.current = es;
  }, [queueName]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
    };
  }, [connect]);

  const reconnect = useCallback(() => {
    setError(null);
    connect();
  }, [connect]);

  return { snapshot, error, reconnect };
}
