"use client";

import { useQueueSSE } from "@/hooks/use-queue-sse";
import { cn } from "@/lib/utils";
import type { QueueJobSummary, QueueSnapshot, ScanProgress } from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { QueueCountsBar } from "./queue-counts-bar";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

export function QueueDetail() {
  const { name } = useParams<{ name: string }>();
  const { snapshot, error, reconnect } = useQueueSSE(name ?? "");

  if (!snapshot && !error) {
    return <QueueDetailSkeleton />;
  }

  return (
    <div className="space-y-4">
      {/* 队列头 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{name}</h1>
          <span
            className={cn(
              "inline-flex h-2 w-2 rounded-full",
              error ? "bg-red-500" : "bg-green-500",
            )}
            title={error ?? "已连接"}
          />
          <span className="text-xs text-muted-foreground">{error ? "连接失败" : "实时连接"}</span>
        </div>
        {error && (
          <button
            type="button"
            onClick={reconnect}
            className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground"
          >
            重连
          </button>
        )}
      </div>

      {snapshot && (
        <>
          {/* 计数条 */}
          <Card>
            <CardContent className="pt-6">
              <QueueCountsBar counts={snapshot.counts} />
            </CardContent>
          </Card>

          {/* 汇总进度 */}
          <AggregateProgress progress={snapshot.aggregateProgress} />

          {/* 最近作业 */}
          <Card>
            <CardHeader className="pb-3">
              <h2 className="text-sm font-semibold">最近作业</h2>
            </CardHeader>
            <CardContent className="space-y-2">
              {snapshot.recentJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无作业记录</p>
              ) : (
                snapshot.recentJobs.map((job) => <JobRow key={job.id} job={job} />)
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** 汇总进度卡片 */
function AggregateProgress({
  progress,
}: {
  progress: QueueSnapshot["aggregateProgress"];
}) {
  if (!progress || progress.totalFiles === 0) {
    return null;
  }

  const pct =
    progress.totalFiles > 0 ? Math.round((progress.processed / progress.totalFiles) * 100) : 0;

  return (
    <Card className="border-blue-200 bg-blue-50/30">
      <CardHeader className="pb-2">
        <h2 className="text-sm font-semibold text-blue-700">汇总进度</h2>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {/* 进度条 */}
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                已处理 {progress.processed} / {progress.totalFiles}
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.max(pct, 1)}%` }}
              />
            </div>
          </div>
          {/* 指标行 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <MetricBadge
              label="新增"
              value={progress.newCount}
              color="text-green-600"
              dot="bg-green-500"
            />
            <MetricBadge
              label="跳过"
              value={progress.skippedCount}
              color="text-slate-500"
              dot="bg-slate-400"
            />
            <MetricBadge
              label="更新"
              value={progress.updatedCount}
              color="text-amber-600"
              dot="bg-amber-500"
            />
            <MetricBadge
              label="重建"
              value={progress.regeneratedCount}
              color="text-blue-600"
              dot="bg-blue-500"
            />
            <MetricBadge
              label="错误"
              value={progress.errorCount}
              color="text-red-600"
              dot="bg-red-500"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricBadge({
  label,
  value,
  color,
  dot,
}: {
  label: string;
  value: number;
  color: string;
  dot: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", color)}>
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dot)} />
      {label} {value}
    </span>
  );
}

function isScanProgress(p: unknown): p is ScanProgress {
  return typeof p === "object" && p !== null && "totalFiles" in p;
}

/** 单个作业行（含内联进度） */
function JobRow({ job }: { job: QueueJobSummary }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const progress = isScanProgress(job.progress) ? job.progress : null;
  const hasProgress = progress && progress.totalFiles > 0;

  const stateBadge: Record<
    string,
    { label: string; variant: "default" | "secondary" | "outline" }
  > = {
    active: { label: "活跃", variant: "default" },
    waiting: { label: "等待", variant: "secondary" },
    completed: { label: "完成", variant: "outline" },
    failed: { label: "失败", variant: "default" },
    delayed: { label: "延迟", variant: "secondary" },
  };

  const sb = stateBadge[job.state] ?? { label: job.state, variant: "outline" as const };

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={sb.variant} className="shrink-0 text-[10px]">
            {sb.label}
          </Badge>
          <span className="truncate text-sm font-medium">{job.name}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {job.attemptsMade > 0 ? `尝试 ${job.attemptsMade} 次` : ""}
        </span>
      </div>

      {/* 内联进度条 */}
      {hasProgress && (
        <div className="mt-2 space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              已处理 {progress.processed} / {progress.totalFiles}
            </span>
            <span>
              {progress.totalFiles > 0
                ? Math.round((progress.processed / progress.totalFiles) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{
                width: `${
                  progress.totalFiles > 0
                    ? Math.max((progress.processed / progress.totalFiles) * 100, 1)
                    : 0
                }%`,
              }}
            />
          </div>
          {progress.currentFile && (
            <p className="truncate text-[11px] text-muted-foreground">
              当前: {progress.currentFile}
            </p>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
            {progress.newCount > 0 && (
              <span className="text-green-600">新增 {progress.newCount}</span>
            )}
            {progress.skippedCount > 0 && (
              <span className="text-slate-500">跳过 {progress.skippedCount}</span>
            )}
            {progress.updatedCount > 0 && (
              <span className="text-amber-600">更新 {progress.updatedCount}</span>
            )}
            {progress.regeneratedCount > 0 && (
              <span className="text-blue-600">重建 {progress.regeneratedCount}</span>
            )}
            {progress.errorCount > 0 && (
              <span className="text-red-600">错误 {progress.errorCount}</span>
            )}
          </div>
        </div>
      )}

      {/* 失败原因 */}
      {job.failedReason && <p className="mt-1 truncate text-xs text-red-600">{job.failedReason}</p>}
    </div>
  );
}

function QueueDetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-2 w-2 rounded-full" />
      </div>
      <Card>
        <CardContent className="pt-6">
          <Skeleton className="h-2 w-full rounded-full" />
          <div className="mt-2 flex gap-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-12" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-16" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </CardContent>
      </Card>
    </div>
  );
}
