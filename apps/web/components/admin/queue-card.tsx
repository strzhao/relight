"use client";

import { cn } from "@/lib/utils";
import type { QueueJobCounts } from "@relight/shared";
import Link from "next/link";

export interface QueueCardData {
  name: string;
  label: string;
  description: string;
  isActive: boolean;
  badge: string | null;
  counts: QueueJobCounts | null;
}

interface QueueCardProps {
  queue: QueueCardData;
  isSelected: boolean;
}

export function QueueCard({ queue, isSelected }: QueueCardProps) {
  const total = queue.counts ? Object.values(queue.counts).reduce((a, b) => a + b, 0) : 0;
  const activeCount = queue.counts?.active ?? 0;
  const failedCount = queue.counts?.failed ?? 0;

  const content = (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors cursor-pointer",
        isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
        !queue.isActive && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{queue.label}</h3>
        {queue.badge && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {queue.badge}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{queue.description}</p>

      {/* 微型进度条 */}
      {total > 0 && (
        <div className="mt-2 space-y-1">
          <div className="flex h-1.5 overflow-hidden rounded-full">
            {activeCount > 0 && (
              <div
                className="bg-blue-500 transition-all"
                style={{ width: `${Math.max((activeCount / total) * 100, 1)}%` }}
              />
            )}
            {failedCount > 0 && (
              <div
                className="bg-red-500 transition-all"
                style={{ width: `${Math.max((failedCount / total) * 100, 1)}%` }}
              />
            )}
          </div>
          <div className="flex gap-2 text-[10px] text-muted-foreground">
            <span>活跃 {activeCount}</span>
            {failedCount > 0 && <span className="text-red-500">失败 {failedCount}</span>}
          </div>
        </div>
      )}
    </div>
  );

  if (!queue.isActive) {
    return content;
  }

  return <Link href={`/admin/queues/${queue.name}`}>{content}</Link>;
}
