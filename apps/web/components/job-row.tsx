"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { QueueJobSummary } from "@relight/shared";

interface JobRowProps {
  job: QueueJobSummary;
  onClick: () => void;
}

const STATE_LABELS: Record<QueueJobSummary["state"], string> = {
  waiting: "等待",
  active: "执行中",
  completed: "已完成",
  failed: "失败",
  delayed: "延迟",
  paused: "暂停",
  unknown: "未知",
};

const STATE_VARIANTS: Record<QueueJobSummary["state"], "default" | "secondary" | "outline"> = {
  waiting: "secondary",
  active: "default",
  completed: "outline",
  failed: "default",
  delayed: "secondary",
  paused: "secondary",
  unknown: "secondary",
};

function formatTime(ts: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function JobRow({ job, onClick }: JobRowProps) {
  const isFailed = job.state === "failed";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 text-left rounded-lg transition-colors hover:bg-accent",
        isFailed && "bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900",
      )}
    >
      <Badge
        variant={STATE_VARIANTS[job.state]}
        className="shrink-0 text-[10px] px-1.5 min-w-[3rem] justify-center"
      >
        {STATE_LABELS[job.state]}
      </Badge>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{job.name}</div>
        <div className="text-[11px] text-muted-foreground truncate">ID: {job.id}</div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-xs text-muted-foreground">{formatTime(job.timestamp)}</div>
        {job.attemptsMade > 1 && (
          <div className="text-[10px] text-muted-foreground">尝试 {job.attemptsMade} 次</div>
        )}
        {job.failedReason && (
          <div className="text-[10px] text-red-500 truncate max-w-[120px]">{job.failedReason}</div>
        )}
      </div>
    </button>
  );
}
