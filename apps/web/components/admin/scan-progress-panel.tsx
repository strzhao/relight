"use client";

import { Button } from "@/components/ui/button";
import type {
  AnalyzeBatchProgressEvent,
  ScanProgressEvent,
  ScanTriggerResponse,
} from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { ChevronDown, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface ProgressPanelProps {
  mode: "scan" | "analyze";
  // Scan mode props
  storageSourceId?: string;
  onScanStart?: () => void;
  onScanComplete?: () => void;
  // Analyze mode props
  filterParams?: {
    storageSourceId?: string;
    minScore?: string;
  };
  onAnalyzeStart?: () => void;
  onAnalyzeComplete?: () => void;
}

type PanelStatus = "idle" | "triggering" | "running" | "completed" | "error";
type ScanMode = "normal" | "forceRegenerate";

const phaseLabels: Record<string, string> = {
  listing: "正在列出文件...",
  hashing: "正在计算文件哈希...",
  processing: "正在处理文件...",
  completed: "扫描完成",
};

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export function ProgressPanel({
  mode,
  storageSourceId,
  onScanStart,
  onScanComplete,
  filterParams,
  onAnalyzeStart,
  onAnalyzeComplete,
}: ProgressPanelProps) {
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [progress, setProgress] = useState<ScanProgressEvent | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<ScanMode>("normal");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const completedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // 分析模式专用状态
  interface AnalyzeProgress {
    batchId: string;
    totalCount: number;
    completedCount: number;
    failedCount: number;
    status: "running" | "completed" | "stale";
  }
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);

  // 清理
  const cleanup = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (completedTimerRef.current) {
      clearTimeout(completedTimerRef.current);
      completedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  // ===== Scan SSE =====
  const connectScanSSE = useCallback(
    (scanLogId: string) => {
      cleanup();

      const url = `${BASE_URL}${API_ROUTES.scan.events(scanLogId)}`;
      const es = new EventSource(url);

      es.addEventListener("progress", (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data) as ScanProgressEvent;
          setProgress(data);

          if (data.status === "completed" || data.status === "failed") {
            setStatus("completed");
            es.close();
            onScanComplete?.();
            // 2 秒后恢复 idle
            completedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) {
                setStatus("idle");
                setProgress(null);
              }
            }, 2000);
          }
        } catch {
          // 解析失败忽略
        }
      });

      es.addEventListener("error", () => {
        if (!mountedRef.current) return;
        if (es.readyState === EventSource.CLOSED) {
          setErrorMessage("连接已关闭");
          setStatus("error");
        }
      });

      es.onopen = () => {
        if (!mountedRef.current) return;
        setErrorMessage(null);
      };

      eventSourceRef.current = es;
    },
    [cleanup, onScanComplete],
  );

  // ===== Analyze SSE =====
  const connectAnalyzeSSE = useCallback(
    (batchId: string) => {
      cleanup();

      const url = `${BASE_URL}${API_ROUTES.admin.photosAnalyzeEvents(batchId)}`;
      const es = new EventSource(url);

      es.addEventListener("progress", (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data) as AnalyzeBatchProgressEvent;
          setAnalyzeProgress(data);

          if (data.status === "completed" || data.status === "stale") {
            setStatus("completed");
            es.close();
            onAnalyzeComplete?.();
            // 3 秒后恢复 idle
            completedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) {
                setStatus("idle");
                setAnalyzeProgress(null);
              }
            }, 3000);
          }
        } catch {
          // 解析失败忽略
        }
      });

      es.addEventListener("error", () => {
        if (!mountedRef.current) return;
        if (es.readyState === EventSource.CLOSED) {
          setErrorMessage("连接已关闭");
          setStatus("error");
        }
      });

      es.onopen = () => {
        if (!mountedRef.current) return;
        setErrorMessage(null);
      };

      eventSourceRef.current = es;
    },
    [cleanup, onAnalyzeComplete],
  );

  // ===== Scan 触发 =====
  const handleScan = useCallback(async () => {
    setStatus("triggering");
    setErrorMessage(null);
    setProgress(null);

    try {
      const res = await fetch(`${BASE_URL}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageSourceId,
          skipAnalysis: true,
          forceRegenerate: scanMode === "forceRegenerate",
        }),
      });
      const body = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: ScanTriggerResponse & { activeScanLogId?: string };
      };

      if (!body.success) {
        if (res.status === 409) {
          setErrorMessage(`已有正在进行的扫描任务 (${body.data?.activeScanLogId ?? "unknown"})`);
        } else {
          setErrorMessage(body.error ?? "触发扫描失败");
        }
        setStatus("error");
        return;
      }

      if (!body.data?.scanLogId) {
        setErrorMessage("未返回扫描记录 ID");
        setStatus("error");
        return;
      }

      onScanStart?.();
      setStatus("running");
      connectScanSSE(body.data.scanLogId);
    } catch (err) {
      setErrorMessage(`请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
      setStatus("error");
    }
  }, [storageSourceId, onScanStart, connectScanSSE, scanMode]);

  // ===== Analyze 触发 =====
  const handleAnalyze = useCallback(async () => {
    setStatus("triggering");
    setErrorMessage(null);
    setAnalyzeProgress(null);

    try {
      const params: Record<string, unknown> = {};
      if (filterParams?.storageSourceId) {
        params.storageSourceId = filterParams.storageSourceId;
      }
      if (filterParams?.minScore) {
        const s = Number(filterParams.minScore);
        if (!Number.isNaN(s)) params.minScore = s;
      }

      const res = await fetch(`${BASE_URL}/api/admin/photos/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: { batchId: string; totalCount: number; skippedCount: number };
        message?: string;
      };

      if (!body.success) {
        setErrorMessage(body.error ?? "触发分析失败");
        setStatus("error");
        return;
      }

      if (!body.data?.batchId || body.data.totalCount === 0) {
        setErrorMessage(body.message ?? "没有需要分析的照片");
        setStatus("error");
        return;
      }

      onAnalyzeStart?.();
      setStatus("running");
      connectAnalyzeSSE(body.data.batchId);
    } catch (err) {
      setErrorMessage(`请求失败: ${err instanceof Error ? err.message : "未知错误"}`);
      setStatus("error");
    }
  }, [filterParams, onAnalyzeStart, connectAnalyzeSSE]);

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

  const handleRetry = useCallback(() => {
    setStatus("idle");
    setErrorMessage(null);
    setProgress(null);
    setAnalyzeProgress(null);
  }, []);

  // ===== 进度百分比 =====
  const scanPercent =
    progress && progress.totalFiles > 0
      ? Math.round((progress.processed / progress.totalFiles) * 100)
      : 0;

  const analyzePercent =
    analyzeProgress && analyzeProgress.totalCount > 0
      ? Math.round(
          ((analyzeProgress.completedCount + analyzeProgress.failedCount) /
            analyzeProgress.totalCount) *
            100,
        )
      : 0;

  return (
    <div className="space-y-2">
      {/* Idle */}
      {status === "idle" &&
        (mode === "scan" ? (
          <div className="relative flex items-center" ref={dropdownRef}>
            <Button variant="default" size="sm" onClick={handleScan} className="rounded-r-none">
              <Play className="size-4" />
              {scanMode === "forceRegenerate" ? "强制重建缩略图" : "触发扫描"}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="rounded-l-none border-l border-primary-foreground/20 px-2"
              onClick={() => setDropdownOpen((v) => !v)}
            >
              <ChevronDown className="size-3.5" />
            </Button>
            {dropdownOpen && (
              <div className="absolute top-full right-0 mt-1 z-50 min-w-[220px] rounded-md border bg-popover shadow-md">
                <div className="p-1">
                  <button
                    type="button"
                    className={`flex w-full items-center rounded-sm px-3 py-2 text-sm ${
                      scanMode === "normal"
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground"
                    }`}
                    onClick={() => {
                      setScanMode("normal");
                      setDropdownOpen(false);
                    }}
                  >
                    <div>
                      <div className="font-medium">触发扫描</div>
                      <div className="text-xs text-muted-foreground">增量扫描，跳过未变更文件</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`flex w-full items-center rounded-sm px-3 py-2 text-sm ${
                      scanMode === "forceRegenerate"
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground"
                    }`}
                    onClick={() => {
                      setScanMode("forceRegenerate");
                      setDropdownOpen(false);
                    }}
                  >
                    <div>
                      <div className="font-medium">强制重建缩略图</div>
                      <div className="text-xs text-muted-foreground">重新生成所有照片缩略图</div>
                    </div>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <Button variant="default" size="sm" onClick={handleAnalyze}>
            <Play className="size-4" />
            触发 AI 分析
          </Button>
        ))}

      {/* Triggering */}
      {status === "triggering" && (
        <Button variant="default" size="sm" disabled>
          <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {mode === "scan" ? "提交中..." : "正在入队..."}
        </Button>
      )}

      {/* Running */}
      {status === "running" && (
        <div className="w-full max-w-xs space-y-1.5">
          {mode === "scan" ? (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{progress?.phase ? phaseLabels[progress.phase] : "扫描中..."}</span>
                <span>{scanPercent}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.min(scanPercent, 100)}%` }}
                />
              </div>
              {progress && (
                <div className="flex gap-3 text-xs text-muted-foreground">
                  {progress.totalFiles > 0 && (
                    <span>
                      {progress.processed}/{progress.totalFiles} 文件
                    </span>
                  )}
                  {progress.newCount > 0 && (
                    <span className="text-green-600">新增 {progress.newCount}</span>
                  )}
                  {progress.regeneratedCount > 0 && (
                    <span className="text-blue-600">重建 {progress.regeneratedCount}</span>
                  )}
                  {progress.skippedCount > 0 && <span>跳过 {progress.skippedCount}</span>}
                  {progress.errorCount > 0 && (
                    <span className="text-destructive">错误 {progress.errorCount}</span>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>正在分析照片...</span>
                <span>{analyzePercent}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${Math.min(analyzePercent, 100)}%` }}
                />
              </div>
              {analyzeProgress && (
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span>
                    {analyzeProgress.completedCount + analyzeProgress.failedCount}/
                    {analyzeProgress.totalCount}
                  </span>
                  {analyzeProgress.completedCount > 0 && (
                    <span className="text-green-600">完成 {analyzeProgress.completedCount}</span>
                  )}
                  {analyzeProgress.failedCount > 0 && (
                    <span className="text-destructive">失败 {analyzeProgress.failedCount}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Completed */}
      {status === "completed" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-green-600">{mode === "scan" ? "扫描完成" : "分析完成"}</span>
          {mode === "scan" && progress && (
            <span className="text-xs text-muted-foreground">
              新增 {progress.newCount} · 跳过 {progress.skippedCount}
              {progress.regeneratedCount > 0 && ` · 重建 ${progress.regeneratedCount}`}
              {progress.errorCount > 0 && ` · 错误 ${progress.errorCount}`}
            </span>
          )}
          {mode === "analyze" && analyzeProgress && (
            <span className="text-xs text-muted-foreground">
              完成 {analyzeProgress.completedCount} · 失败 {analyzeProgress.failedCount}
            </span>
          )}
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-destructive text-xs">{errorMessage}</span>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            <RefreshCw className="size-3" />
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

/** 向后兼容别名 */
export { ProgressPanel as ScanProgressPanel };
