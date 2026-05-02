"use client";

import { QueueDetail } from "@/components/queue-detail";
import { isValidQueueName } from "@/hooks/use-queue-sse";
import { useParams } from "next/navigation";

const LABELS: Record<string, string> = {
  "scan-storage": "扫描存储",
  "analyze-photo": "AI 分析",
  "daily-selection": "每日精选",
};

export default function QueueDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params?.name ?? "";

  if (!isValidQueueName(name)) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-lg font-semibold">未知队列</p>
          <p className="text-sm text-muted-foreground mt-1">请在左侧选择一个有效队列</p>
        </div>
      </div>
    );
  }

  return <QueueDetail queueName={name} label={LABELS[name] ?? name} />;
}
