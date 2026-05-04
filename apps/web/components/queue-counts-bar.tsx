"use client";

import { cn } from "@/lib/utils";
import type { QueueJobCounts } from "@relight/shared";

const STATE_CONFIG: Record<keyof QueueJobCounts, { label: string; color: string }> = {
  waiting: { label: "等待", color: "bg-status-waiting" },
  active: { label: "活跃", color: "bg-status-active" },
  completed: { label: "完成", color: "bg-status-completed" },
  failed: { label: "失败", color: "bg-status-failed" },
  delayed: { label: "延迟", color: "bg-status-delayed" },
  paused: { label: "暂停", color: "bg-status-paused" },
};

interface QueueCountsBarProps {
  counts: QueueJobCounts;
}

export function QueueCountsBar({ counts }: QueueCountsBarProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full">
        {(Object.keys(STATE_CONFIG) as Array<keyof QueueJobCounts>).map((key) => {
          const count = counts[key];
          if (count === 0) return null;
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div
              key={key}
              className={cn(STATE_CONFIG[key].color, "transition-all duration-300")}
              style={{ width: `${Math.max(pct, 1)}%` }}
              title={`${STATE_CONFIG[key].label}: ${count}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(STATE_CONFIG) as Array<keyof QueueJobCounts>).map((key) => (
          <span key={key} className="inline-flex items-center gap-1">
            <span className={cn("inline-block h-2 w-2 rounded-full", STATE_CONFIG[key].color)} />
            {STATE_CONFIG[key].label}: {counts[key]}
          </span>
        ))}
      </div>
    </div>
  );
}
