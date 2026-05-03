"use client";

import { QueueCard } from "@/components/queue-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueuesPoll } from "@/hooks/use-queues-poll";
import { useParams, useRouter } from "next/navigation";

export default function QueuesLayout({ children }: { children: React.ReactNode }) {
  const { queues, loading, error } = useQueuesPoll();
  const params = useParams<{ name?: string }>();
  const router = useRouter();
  const selectedName = params?.name ?? null;

  const handleSelect = (name: string) => {
    router.push(`/admin/queues/${name}`);
  };

  return (
    <div className="flex h-screen">
      {/* 侧边栏 */}
      <aside className="w-72 shrink-0 border-r bg-card overflow-y-auto p-4 space-y-3">
        <div className="pb-3">
          <h2 className="text-lg font-bold">队列监控</h2>
          <p className="text-xs text-muted-foreground">BullMQ 实时状态</p>
        </div>

        {loading &&
          [1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border p-4 space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-1.5 w-full" />
            </div>
          ))}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {!loading &&
          !error &&
          queues.map((q) => (
            <QueueCard
              key={q.name}
              name={q.name}
              label={q.label}
              description={q.description}
              isActive={q.isActive}
              badge={q.badge}
              counts={q.counts}
              isSelected={selectedName === q.name}
              onClick={() => q.isActive && handleSelect(q.name)}
            />
          ))}
      </aside>

      {/* 详情区域 */}
      <main className="flex-1 overflow-y-auto bg-background">{children}</main>
    </div>
  );
}
