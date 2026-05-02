import type { QueueStatus } from "@relight/shared";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface QueueCardProps {
  queue: QueueStatus;
}

const statusLabels: Record<string, { label: string; className: string }> = {
  waiting: { label: "等待", className: "bg-yellow-100 text-yellow-800" },
  active: { label: "进行中", className: "bg-blue-100 text-blue-800" },
  completed: { label: "已完成", className: "bg-green-100 text-green-800" },
  failed: { label: "失败", className: "bg-red-100 text-red-800" },
  delayed: { label: "延迟", className: "bg-purple-100 text-purple-800" },
};

export function QueueCard({ queue }: QueueCardProps) {
  const total =
    (queue.counts.waiting || 0) +
    (queue.counts.active || 0) +
    (queue.counts.completed || 0) +
    (queue.counts.failed || 0) +
    (queue.counts.delayed || 0);

  const progressPercent =
    total > 0 ? Math.round(((queue.counts.completed || 0) / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">{queue.name}</h3>
          <span className="text-xs text-muted-foreground">{total} 任务</span>
        </div>
      </CardHeader>
      <CardContent>
        {/* 进度条 */}
        {total > 0 && (
          <div className="mb-3 h-2 w-full rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}

        {/* 状态统计 */}
        <div className="flex flex-wrap gap-2">
          {Object.entries(queue.counts).map(([key, value]) => {
            if (value === 0) return null;
            const status = statusLabels[key];
            return (
              <Badge
                key={key}
                variant="secondary"
                className={status?.className}
              >
                {status?.label ?? key}: {value}
              </Badge>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
