"use client";

import type { QueueSnapshot } from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { useCallback, useEffect, useRef, useState } from "react";

interface UseQueueSSEReturn {
  snapshot: QueueSnapshot | null;
  connected: boolean;
  error: string | null;
  reconnect: () => void;
}

const KNOWN_QUEUES = ["scan-storage", "analyze-photo", "daily-selection"] as const;

export function isValidQueueName(name: string): name is (typeof KNOWN_QUEUES)[number] {
  return (KNOWN_QUEUES as readonly string[]).includes(name);
}

export function useQueueSSE(name: string): UseQueueSSEReturn {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectCountRef = useRef(0);

  const connect = useCallback(() => {
    if (!isValidQueueName(name)) {
      setError(`未知队列: ${name}`);
      return;
    }

    // 关闭已有连接
    eventSourceRef.current?.close();

    // 重置快照状态（切换队列时清空旧数据）
    setSnapshot(null);
    setError(null);

    const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
    const url = `${baseUrl}${API_ROUTES.queues.events(name)}`;
    const es = new EventSource(url);

    es.addEventListener("snapshot", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as QueueSnapshot;
        setSnapshot(data);
        setConnected(true);
        setError(null);
      } catch {
        setError("快照解析失败");
      }
    });

    // 自定义 SSE error 事件（后端业务错误，如 Redis 连接失败）
    es.addEventListener("error", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { error?: string };
        if (data.error) {
          setError(data.error);
        }
      } catch {
        // 原生 EventSource 连接错误，由 onerror 处理
      }
    });

    // 原生 EventSource 连接错误
    es.onerror = () => {
      setConnected(false);
      if (es.readyState === EventSource.CLOSED) {
        setError("连接已关闭");
      }
    };

    es.onopen = () => {
      setConnected(true);
      setError(null);
      reconnectCountRef.current = 0;
    };

    eventSourceRef.current = es;
  }, [name]);

  const reconnect = useCallback(() => {
    reconnectCountRef.current += 1;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  return { snapshot, connected, error, reconnect };
}
