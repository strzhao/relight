"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ScanTriggerButtonProps {
  storageSourceId?: string;
}

export function ScanTriggerButton({ storageSourceId }: ScanTriggerButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleScan() {
    setLoading(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageSourceId }),
      });
      const body = await res.json();
      if (body.success) {
        alert(`扫描任务已提交，Job ID: ${body.data.jobId}`);
      } else {
        alert(`扫描失败: ${body.error}`);
      }
    } catch (error) {
      alert(`请求失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleScan}
      disabled={loading}
    >
      <Play className="size-4" />
      {loading ? "提交中..." : "触发扫描"}
    </Button>
  );
}
