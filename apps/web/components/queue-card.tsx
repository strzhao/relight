"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { QueueInfo } from "@relight/shared";

interface QueueCardProps {
  /** 便捷模式：直接传入 QueueInfo 对象 */
  queue?: QueueInfo;
  /** 也支持逐个 prop 传入（与 queue 互斥，queue 优先级更高） */
  name?: string;
  label?: string;
  description?: string;
  isActive?: boolean;
  badge?: string | null;
  counts?: QueueInfo["counts"];
  isSelected: boolean;
  onClick: () => void;
  loading?: boolean;
}

function CountsMiniBar({ counts }: { counts: QueueInfo["counts"] }) {
  if (!counts) return null;
  const total =
    counts.waiting +
    counts.active +
    counts.completed +
    counts.failed +
    counts.delayed +
    counts.paused;
  if (total === 0) {
    return <span className="text-xs text-muted-foreground">暂无作业</span>;
  }

  const segments = [
    { label: "等", value: counts.waiting, color: "bg-gray-400" },
    { label: "活", value: counts.active, color: "bg-blue-500" },
    { label: "完", value: counts.completed, color: "bg-green-500" },
    { label: "败", value: counts.failed, color: "bg-red-500" },
    { label: "延", value: counts.delayed, color: "bg-yellow-500" },
    { label: "停", value: counts.paused, color: "bg-purple-400" },
  ].filter((s) => s.value > 0);

  return (
    <div className="flex items-center gap-2 mt-1.5">
      <div className="flex h-1.5 flex-1 rounded-full overflow-hidden">
        {segments.map((s) => (
          <div
            key={s.label}
            className={cn(s.color, "h-full transition-all")}
            style={{ width: `${(s.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex gap-1 text-[10px] text-muted-foreground">
        {segments.map((s) => (
          <span key={s.label} className="tabular-nums">
            {s.value}
          </span>
        ))}
      </div>
    </div>
  );
}

export function QueueCard(props: QueueCardProps) {
  const { isSelected, onClick, loading = false } = props;

  // 优先使用 queue 对象，否则使用逐个 prop
  const name = props.queue?.name ?? props.name ?? "";
  const label = props.queue?.label ?? props.label ?? "";
  const description = props.queue?.description ?? props.description ?? "";
  const isActive = props.queue?.isActive ?? props.isActive ?? true;
  const badgeText = props.queue?.badge ?? props.badge ?? null;
  const counts = props.queue?.counts ?? props.counts ?? null;

  if (loading) {
    return (
      <div className="rounded-xl border p-4">
        <Skeleton className="h-5 w-24 mb-2" />
        <Skeleton className="h-3 w-40 mb-3" />
        <Skeleton className="h-1.5 w-full" />
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!isActive}
      onClick={onClick}
      className={cn(
        "w-full rounded-xl border p-4 text-left transition-all",
        isActive && "hover:border-primary/50 cursor-pointer",
        !isActive && "opacity-60 cursor-not-allowed",
        isSelected && "border-primary ring-1 ring-primary",
        !isSelected && "border-border",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{label}</span>
        {badgeText && (
          <Badge variant="secondary" className="text-[10px]">
            {badgeText}
          </Badge>
        )}
        {!isActive && !badgeText && <span className="text-[10px] text-muted-foreground">停用</span>}
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      <CountsMiniBar counts={counts} />
    </button>
  );
}
