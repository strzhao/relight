"use client";

import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { useState } from "react";

interface AnalyzeTriggerButtonProps {
  photoIds: string[];
  disabled?: boolean;
  onSuccess?: () => void;
}

export function AnalyzeTriggerButton({ photoIds, disabled, onSuccess }: AnalyzeTriggerButtonProps) {
  const [loading, setLoading] = useState(false);

  async function handleAnalyze() {
    setLoading(true);
    try {
      const res = await fetch("/api/photos/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoIds }),
      });
      const body = await res.json();
      if (body.success) {
        alert(`分析任务已提交，共 ${body.data.enqueued} 张照片`);
        onSuccess?.();
      } else {
        alert(`提交失败: ${body.error}`);
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
      onClick={handleAnalyze}
      disabled={disabled || loading || photoIds.length === 0}
    >
      <Sparkles className="size-4" />
      {loading ? "提交中..." : `分析选中 (${photoIds.length})`}
    </Button>
  );
}
