"use client";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { QueueJobDetail } from "@relight/shared";
import { useCallback, useEffect, useState } from "react";

interface JobDetailDialogProps {
  queueName: string;
  jobId: string;
  open: boolean;
  onClose: () => void;
}

function JsonBlock({ title, data }: { title: string; data: unknown }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold">{title}</h4>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
        {data != null ? JSON.stringify(data, null, 2) : "null"}
      </pre>
    </div>
  );
}

export function JobDetailDialog({ queueName, jobId, open, onClose }: JobDetailDialogProps) {
  const [detail, setDetail] = useState<QueueJobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.queues.job(queueName, jobId);
      setDetail(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取作业详情失败");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [queueName, jobId]);

  useEffect(() => {
    if (open && jobId) {
      fetchDetail();
    } else {
      setDetail(null);
      setError(null);
    }
  }, [open, jobId, fetchDetail]);

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            作业详情
            {detail && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">#{detail.id}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {error && <div className="text-sm text-destructive p-4">{error}</div>}

        {detail && (
          <div className="space-y-4">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <div>
                <span className="text-xs text-muted-foreground">名称</span>
                <p className="text-sm font-medium">{detail.name}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">状态</span>
                <div>
                  <Badge variant="secondary" className="mt-0.5 text-[10px]">
                    {detail.state}
                  </Badge>
                </div>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">创建时间</span>
                <p className="text-sm">
                  {detail.timestamp ? new Date(detail.timestamp).toLocaleString("zh-CN") : "-"}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">尝试次数</span>
                <p className="text-sm">{detail.attemptsMade}</p>
              </div>
              {detail.processedOn != null && (
                <div>
                  <span className="text-xs text-muted-foreground">开始处理</span>
                  <p className="text-sm">{new Date(detail.processedOn).toLocaleString("zh-CN")}</p>
                </div>
              )}
              {detail.finishedOn != null && (
                <div>
                  <span className="text-xs text-muted-foreground">完成时间</span>
                  <p className="text-sm">{new Date(detail.finishedOn).toLocaleString("zh-CN")}</p>
                </div>
              )}
            </div>

            {detail.failedReason && (
              <div>
                <span className="text-xs font-semibold text-destructive">失败原因</span>
                <p className="text-sm text-destructive mt-1">{detail.failedReason}</p>
              </div>
            )}

            <Separator />

            {/* 数据 */}
            <JsonBlock title="作业数据 (data)" data={detail.data} />
            <JsonBlock title="作业选项 (opts)" data={detail.opts} />

            {detail.progress != null && detail.progress !== 0 && (
              <div>
                <h4 className="text-xs font-semibold">进度 (progress)</h4>
                <p className="text-sm mt-1">
                  {typeof detail.progress === "object"
                    ? JSON.stringify(detail.progress)
                    : String(detail.progress)}
                </p>
              </div>
            )}

            {detail.returnvalue != null && (
              <JsonBlock title="返回值 (returnvalue)" data={detail.returnvalue} />
            )}

            {detail.stacktrace.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-xs font-semibold text-destructive">堆栈跟踪 (stacktrace)</h4>
                {detail.stacktrace.map((line, i) => (
                  <pre
                    key={`trace-${i}-${line.slice(0, 20)}`}
                    className="text-xs text-destructive whitespace-pre-wrap break-all bg-destructive/10 rounded p-2 dark:bg-destructive/15"
                  >
                    {line}
                  </pre>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
