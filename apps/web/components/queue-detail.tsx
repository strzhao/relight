"use client";

import { JobCountsBar } from "@/components/job-counts-bar";
import { JobDetailDialog } from "@/components/job-detail-dialog";
import { JobRow } from "@/components/job-row";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueueSSE } from "@/hooks/use-queue-sse";
import { cn } from "@/lib/utils";
import type { QueueJobSummary } from "@relight/shared";
import { useState } from "react";

interface QueueDetailProps {
  queueName: string;
  label: string;
}

export function QueueDetail({ queueName, label }: QueueDetailProps) {
  const { snapshot, connected, error } = useQueueSSE(queueName);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleJobClick = (job: QueueJobSummary) => {
    setSelectedJobId(job.id);
    setDialogOpen(true);
  };

  // 加载态：尚未收到第一个快照
  if (!snapshot) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">{label}</h1>
            <p className="text-sm text-muted-foreground">{queueName}</p>
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-24 w-full" />
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton array, no reorder
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* 队列头部 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{label}</h1>
          <p className="text-sm text-muted-foreground">{queueName}</p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              connected ? "bg-green-500" : "bg-red-500",
            )}
          />
          <span className="text-xs text-muted-foreground">
            {connected ? "已连接" : error ? `断开: ${error}` : "连接中..."}
          </span>
        </div>
      </div>

      {/* 作业计数条 */}
      <JobCountsBar counts={snapshot.counts} />

      <Separator />

      {/* 最近作业列表 */}
      <div>
        <h2 className="text-sm font-semibold mb-3">
          最近作业
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            ({snapshot.recentJobs.length})
          </span>
        </h2>

        {snapshot.recentJobs.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">暂无最近作业</div>
        ) : (
          <div className="space-y-0.5">
            {snapshot.recentJobs.map((job) => (
              <JobRow key={job.id} job={job} onClick={() => handleJobClick(job)} />
            ))}
          </div>
        )}
      </div>

      {/* 作业详情对话框 */}
      <JobDetailDialog
        queueName={queueName}
        jobId={selectedJobId ?? ""}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}
