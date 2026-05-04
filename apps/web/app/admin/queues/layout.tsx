"use client";

import { QueueCard, type QueueCardData } from "@/components/admin/queue-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { QueueJobCounts } from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

export default function AdminQueuesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [queues, setQueues] = useState<QueueCardData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchQueues = useCallback(async () => {
    try {
      const res = await fetch(API_ROUTES.queues.list);
      const json = (await res.json()) as { success: boolean; data: QueueCardData[] };
      if (json.success) {
        setQueues(json.data);
        setError(null);
      }
    } catch {
      setError("获取队列列表失败");
    }
  }, []);

  useEffect(() => {
    void fetchQueues();
    const interval = setInterval(fetchQueues, 5000);
    return () => clearInterval(interval);
  }, [fetchQueues]);

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0">
      {/* 侧边栏 */}
      <aside className="w-64 shrink-0 border-r p-4 overflow-y-auto">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          任务队列
        </h2>
        {queues.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : (
          <div className="space-y-1.5">
            {queues.map((q) => (
              <QueueCard
                key={q.name}
                queue={q}
                isSelected={pathname === `/admin/queues/${q.name}`}
              />
            ))}
          </div>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </aside>

      {/* 详情区 */}
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
