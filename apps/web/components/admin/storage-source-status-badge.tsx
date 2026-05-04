"use client";

import { Badge } from "@/components/ui/badge";
import type { StorageSourceStatus } from "@relight/shared";

interface StorageSourceStatusBadgeProps {
  status: StorageSourceStatus;
  lastError?: string | null;
}

const statusConfig: Record<
  StorageSourceStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  healthy: { label: "正常", variant: "default" },
  unknown: { label: "未知", variant: "secondary" },
  inaccessible: { label: "不可达", variant: "destructive" },
  unmounted: { label: "未挂载", variant: "destructive" },
  permission_denied: { label: "无权限", variant: "destructive" },
};

export function StorageSourceStatusBadge({ status, lastError }: StorageSourceStatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.unknown;

  const tooltipText = lastError
    ? `${config.label}: ${lastError}`
    : status === "healthy"
      ? "存储源路径可正常访问"
      : status === "unknown"
        ? "尚未检查，状态未知"
        : config.label;

  return (
    <span className="relative group inline-flex">
      <Badge variant={config.variant} className="text-xs cursor-help">
        {config.label}
      </Badge>
      {/* Simple CSS tooltip on hover */}
      <span className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 text-xs rounded-md bg-popover border shadow-md text-popover-foreground whitespace-nowrap max-w-xs truncate z-50">
        {tooltipText}
      </span>
    </span>
  );
}
