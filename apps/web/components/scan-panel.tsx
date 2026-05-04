"use client";

import { api } from "@/lib/api";
import type { FileTreeNode, StorageSource, StorageSourceStatus } from "@relight/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileTree } from "./file-tree";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

type ScanStatus = "idle" | "scanning" | "scan_complete" | "analyzing" | "complete" | "error";

const blockedStatuses: StorageSourceStatus[] = ["inaccessible", "unmounted", "permission_denied"];

export function ScanPanel() {
  // 存储源
  const [sources, setSources] = useState<StorageSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);

  // 扫描状态
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [scanError, setScanError] = useState<string | null>(null);

  // 文件树
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [treeStats, setTreeStats] = useState<{
    totalFiles: number;
    analyzedCount: number;
    pendingCount: number;
    failedCount: number;
  } | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);

  // 选择
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 分析
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    queued: number;
    skipped: number;
  } | null>(null);

  // 确认对话框
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState("");
  const [pendingAnalyze, setPendingAnalyze] = useState<{
    photoIds: string[];
    force: boolean;
  } | null>(null);

  // 轮询用 ref
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 加载存储源
  useEffect(() => {
    async function loadSources() {
      try {
        const res = await api.storage.list();
        if (res.success) {
          setSources(res.data);
          if (res.data.length === 1 && res.data[0]) {
            setSelectedSourceId(res.data[0].id);
          }
        }
      } catch (err) {
        console.error("加载存储源失败:", err);
      } finally {
        setSourcesLoading(false);
      }
    }
    loadSources();
  }, []);

  // 选中的存储源状态
  const selectedSource = sources.find((s) => s.id === selectedSourceId);
  const isSourceBlocked =
    !!selectedSource?.status && blockedStatuses.includes(selectedSource.status);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // 加载文件树（定义在前，供 handleStartScan 和 handleAnalyze 引用）
  const loadFileTree = useCallback(async (sourceId: string) => {
    setTreeLoading(true);
    try {
      const res = await api.storage.files(sourceId);
      if (res.success) {
        setFileTree(res.data.tree);
        setTreeStats({
          totalFiles: res.data.totalFiles,
          analyzedCount: res.data.analyzedCount,
          pendingCount: res.data.pendingCount,
          failedCount: res.data.failedCount,
        });
      }
    } catch (err) {
      setScanError(`加载文件树失败: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    } finally {
      setTreeLoading(false);
    }
  }, []);

  // 全选 / 取消全选
  const handleSelectAll = useCallback(() => {
    const allIds = collectAllPhotoIds(fileTree);
    setSelectedIds(new Set(allIds));
  }, [fileTree]);

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // 执行分析（定义在前，供 confirmAnalyze 引用）
  const handleAnalyze = useCallback(
    async (photoIds: string[], force: boolean) => {
      setConfirmOpen(false);
      setPendingAnalyze(null);

      if (photoIds.length === 0) return;

      setStatus("analyzing");

      try {
        const res = await api.analyze.trigger(photoIds, force);
        if (res.success) {
          setAnalyzeProgress({
            queued: res.data.queuedCount,
            skipped: res.data.skippedCount,
          });
          setStatus("complete");
          // 重新加载文件树更新状态
          if (selectedSourceId) {
            await loadFileTree(selectedSourceId);
          }
        }
      } catch (err) {
        setScanError(`触发分析失败: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
      }
    },
    [selectedSourceId, loadFileTree],
  );

  // 确认分析（弹窗确认）
  const confirmAnalyze = useCallback(
    (photoIds: string[], force: boolean) => {
      if (force) {
        setConfirmMessage(`确认对 ${photoIds.length} 个文件重新分析？已分析的结果将被覆盖。`);
        setConfirmOpen(true);
        setPendingAnalyze({ photoIds, force: true });
      } else {
        handleAnalyze(photoIds, false);
      }
    },
    [handleAnalyze],
  );

  // 触发分析（检测是否需要确认）
  const handleTriggerAnalyze = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    // 检查是否有已分析的文件
    const hasAnalyzed = ids.some((id) => {
      const node = findNodeByIdList(fileTree, id);
      return node?.analysisStatus === "analyzed";
    });

    if (hasAnalyzed) {
      confirmAnalyze(ids, true);
    } else {
      handleAnalyze(ids, false);
    }
  }, [selectedIds, fileTree, confirmAnalyze, handleAnalyze]);

  // 重置
  const handleReset = useCallback(() => {
    setStatus("idle");
    setScanError(null);
    setFileTree([]);
    setSelectedIds(new Set());
    setTreeStats(null);
    setAnalyzeProgress(null);
  }, []);

  // 触发扫描
  const handleStartScan = useCallback(async () => {
    if (!selectedSourceId) return;

    setStatus("scanning");
    setScanError(null);
    setFileTree([]);
    setSelectedIds(new Set());
    setTreeStats(null);

    try {
      const res = await api.scan.trigger(selectedSourceId, true);
      if (!res.success) {
        setScanError("启动扫描失败");
        setStatus("error");
        return;
      }

      // 轮询扫描状态
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000"}/api/scan/${selectedSourceId}`,
          );
          const statusData = await statusRes.json();

          if (!statusData.success) return;

          const scanStatus = statusData.data.status;

          if (scanStatus === "completed") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setStatus("scan_complete");
            loadFileTree(selectedSourceId);
          } else if (scanStatus === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setScanError(statusData.data.errorMessage ?? "扫描失败");
            setStatus("error");
          }
        } catch {
          // 轮询失败，忽略
        }
      }, 2000);
    } catch (err) {
      setScanError(`启动扫描失败: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    }
  }, [selectedSourceId, loadFileTree]);

  // ----- Render -----

  if (sourcesLoading) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">请先配置存储源</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      {/* 标题和存储源选择 */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">文件扫描与分析</h1>

        {sources.length > 1 && (
          <select
            className="rounded-md border px-3 py-1.5 text-sm"
            value={selectedSourceId ?? ""}
            onChange={(e) => setSelectedSourceId(e.target.value)}
            disabled={status === "scanning" || status === "analyzing"}
          >
            <option value="" disabled>
              选择存储源
            </option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 状态区域 */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        {/* 存储源不可访问告警 */}
        {isSourceBlocked && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <strong>存储源不可用：</strong>
            {selectedSource?.lastError ?? "路径无法访问"}
          </div>
        )}

        {/* Idle */}
        {status === "idle" && (
          <div className="flex items-center gap-3">
            <Button
              onClick={handleStartScan}
              disabled={!selectedSourceId || isSourceBlocked}
              title={isSourceBlocked ? "存储源路径不可达，无法启动扫描" : undefined}
            >
              开始扫描
            </Button>
            <span className="text-sm text-muted-foreground">扫描文件但先不进行 AI 分析</span>
          </div>
        )}

        {/* Scanning */}
        {status === "scanning" && (
          <div className="flex items-center gap-3">
            <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm">正在扫描存储源...</span>
          </div>
        )}

        {/* Scan Complete */}
        {status === "scan_complete" && (
          <div className="space-y-3">
            {treeStats && (
              <div className="flex gap-4 text-sm">
                <span>
                  共 <strong>{treeStats.totalFiles}</strong> 个文件
                </span>
                <span className="text-status-completed">
                  已分析: <strong>{treeStats.analyzedCount}</strong>
                </span>
                <span className="text-muted-foreground">
                  待分析: <strong>{treeStats.pendingCount}</strong>
                </span>
              </div>
            )}

            {treeLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : fileTree.length > 0 ? (
              <>
                {/* 操作栏 */}
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleSelectAll}>
                    全选
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDeselectAll}>
                    取消全选
                  </Button>
                  <span className="text-xs text-muted-foreground ml-2">
                    已选 {selectedIds.size} 个文件
                  </span>
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    onClick={handleTriggerAnalyze}
                    disabled={selectedIds.size === 0 || isSourceBlocked}
                    title={isSourceBlocked ? "存储源路径不可达，无法触发分析" : undefined}
                  >
                    分析选中 ({selectedIds.size})
                  </Button>
                </div>

                {/* 文件树 */}
                <FileTree
                  tree={fileTree}
                  selectedIds={selectedIds}
                  onSelectionChange={setSelectedIds}
                  disabled={false}
                />

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleReset}>
                    重新选择
                  </Button>
                </div>
              </>
            ) : (
              <div className="py-8 text-center">
                <p className="text-muted-foreground text-sm">
                  未找到图片文件。请确认存储路径是否正确。
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={handleReset}>
                  返回
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Analyzing */}
        {status === "analyzing" && (
          <div className="flex items-center gap-3">
            <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm">正在提交分析任务...</span>
          </div>
        )}

        {/* Complete */}
        {status === "complete" && analyzeProgress && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-status-completed">
              <span>分析任务已提交</span>
            </div>
            <div className="text-sm text-muted-foreground">
              已入队 {analyzeProgress.queued} 个文件
              {analyzeProgress.skipped > 0 && `，跳过 ${analyzeProgress.skipped} 个已分析文件`}
            </div>
            {treeStats && (
              <div className="flex gap-4 text-sm">
                <span>
                  共 <strong>{treeStats.totalFiles}</strong> 个文件
                </span>
                <span className="text-status-completed">
                  已分析: <strong>{treeStats.analyzedCount}</strong>
                </span>
                <span className="text-muted-foreground">
                  待分析: <strong>{treeStats.pendingCount}</strong>
                </span>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                返回首页
              </Button>
            </div>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{scanError}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleReset}>
                重试
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 确认对话框 */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认重新分析</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{confirmMessage}</p>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirmOpen(false);
                setPendingAnalyze(null);
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (pendingAnalyze) {
                  handleAnalyze(pendingAnalyze.photoIds, pendingAnalyze.force);
                }
              }}
            >
              确认分析
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 收集树中所有 photoId */
function collectAllPhotoIds(nodes: FileTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.type === "file" && node.photoId) {
      ids.push(node.photoId);
    }
    if (node.children) {
      ids.push(...collectAllPhotoIds(node.children));
    }
  }
  return ids;
}

/** 在树中查找节点 */
function findNodeByIdList(nodes: FileTreeNode[], photoId: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.type === "file" && node.photoId === photoId) return node;
    if (node.children) {
      const found = findNodeByIdList(node.children, photoId);
      if (found) return found;
    }
  }
  return null;
}
