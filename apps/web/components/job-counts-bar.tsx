"use client";

import { cn } from "@/lib/utils";
import type { QueueJobCounts } from "@relight/shared";

interface JobCountsBarProps {
  counts: QueueJobCounts;
}

const SEGMENTS = [
  { key: "waiting" as const, label: "等待中", color: "bg-status-waiting" },
  { key: "active" as const, label: "执行中", color: "bg-status-active" },
  { key: "completed" as const, label: "已完成", color: "bg-status-completed" },
  { key: "failed" as const, label: "失败", color: "bg-status-failed" },
  { key: "delayed" as const, label: "延迟", color: "bg-status-delayed" },
  { key: "paused" as const, label: "暂停", color: "bg-status-paused" },
];

export function JobCountsBar({ counts }: JobCountsBarProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden">
        {total === 0 ? (
          <div className="h-full w-full bg-muted" />
        ) : (
          SEGMENTS.map(({ key, color }) => {
            const value = counts[key];
            if (value === 0) return null;
            return (
              <div
                key={key}
                className={cn(color, "h-full transition-all")}
                style={{ width: `${(value / total) * 100}%` }}
              />
            );
          })
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {SEGMENTS.map(({ key, label, color }) => (
          <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("inline-block size-2.5 rounded-sm", color)} />
            <span>{label}</span>
            <span className="tabular-nums font-medium text-foreground">{counts[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
