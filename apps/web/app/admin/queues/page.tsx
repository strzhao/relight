import { QueueCard } from "@/components/admin/queue-card";
import { RefreshButton } from "@/components/admin/refresh-button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getQueuesStatus } from "@/lib/admin-data";
import type { QueuesStatus } from "@relight/shared";

export default async function AdminQueuesPage() {
  let queues: QueuesStatus | null = null;
  let error: string | null = null;

  try {
    queues = await getQueuesStatus();
  } catch (err) {
    error = err instanceof Error ? err.message : "获取队列状态失败";
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">队列监控</h2>
          <p className="text-sm text-muted-foreground">BullMQ 队列状态，每队列 5 种状态计数</p>
        </div>
        <RefreshButton />
      </div>

      {/* 错误状态 */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
          </CardContent>
        </Card>
      )}

      {/* 队列卡片 */}
      {queues ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {queues.map((queue) => (
            <QueueCard key={queue.name} queue={queue} />
          ))}
        </div>
      ) : (
        !error && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={`skeleton-queue-${i}`}>
                <CardContent className="space-y-3 pt-6">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-2 w-full rounded-full" />
                  <Skeleton className="h-5 w-24" />
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}
