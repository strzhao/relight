"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronDown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface AnalyzeTriggerButtonProps {
  photoIds: string[];
  disabled?: boolean;
  onSuccess?: () => void;
}

type AnalyzeMode = "normal" | "force";

export function AnalyzeTriggerButton({ photoIds, disabled, onSuccess }: AnalyzeTriggerButtonProps) {
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [analyzeMode, setAnalyzeMode] = useState<AnalyzeMode>("normal");
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const handleAnalyze = useCallback(
    async (force: boolean) => {
      setLoading(true);
      setDropdownOpen(false);
      try {
        const result = await api.photos.analyze(photoIds, force);
        if (result.success) {
          const { enqueued, skippedCount } = result.data;
          if (force) {
            alert(`强制分析已提交，共 ${enqueued} 张照片`);
          } else if (skippedCount > 0) {
            alert(`分析任务已提交，${enqueued} 张入队，${skippedCount} 张已分析自动跳过`);
          } else {
            alert(`分析任务已提交，共 ${enqueued} 张照片`);
          }
          onSuccess?.();
        } else {
          alert(`提交失败: ${result.error}`);
        }
      } catch (error) {
        alert(`请求失败: ${error instanceof Error ? error.message : "未知错误"}`);
      } finally {
        setLoading(false);
      }
    },
    [photoIds, onSuccess],
  );

  return (
    <>
      {/* Split button + dropdown */}
      <div className="relative flex items-center" ref={dropdownRef}>
        <Button
          variant="default"
          size="sm"
          onClick={() => handleAnalyze(false)}
          className="rounded-r-none"
          disabled={disabled || loading || photoIds.length === 0}
        >
          <Sparkles className="size-4" />
          {loading ? "提交中..." : `分析选中 (${photoIds.length})`}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="rounded-l-none border-l border-primary-foreground/20 px-2"
          onClick={() => setDropdownOpen((v) => !v)}
          disabled={disabled || loading || photoIds.length === 0}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        {dropdownOpen && (
          <div className="absolute top-full right-0 mt-1 z-50 min-w-[220px] rounded-md border bg-popover shadow-md">
            <div className="p-1">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-sm px-3 py-2 text-sm",
                  analyzeMode === "normal"
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => {
                  setAnalyzeMode("normal");
                  setDropdownOpen(false);
                  handleAnalyze(false);
                }}
              >
                <div className="text-left">
                  <div className="font-medium">AI 分析</div>
                  <div className="text-xs text-muted-foreground">跳过已分析的照片</div>
                </div>
              </button>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center rounded-sm px-3 py-2 text-sm",
                  analyzeMode === "force"
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => {
                  setAnalyzeMode("force");
                  setDropdownOpen(false);
                  setConfirmOpen(true);
                }}
              >
                <div className="text-left">
                  <div className="font-medium">强制重新分析</div>
                  <div className="text-xs text-muted-foreground">重新分析所有选中照片</div>
                </div>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation dialog for force analyze */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认强制重新分析</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要重新分析已选中的 {photoIds.length} 张照片吗？已分析过的照片将被重新分析。
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                handleAnalyze(true);
              }}
            >
              <Sparkles className="size-4" />
              确认分析
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
