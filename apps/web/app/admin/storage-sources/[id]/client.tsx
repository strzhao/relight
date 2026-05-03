"use client";

import { AnalyzeTriggerButton } from "@/components/admin/analyze-trigger-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PhotoRow } from "./types";

interface Props {
  photos: PhotoRow[];
  storageSourceId: string;
  page: number;
  totalPages: number;
  isScanning?: boolean;
}

export function StorageSourcePhotosTable({
  photos,
  storageSourceId,
  page,
  totalPages,
  isScanning,
}: Props) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === photos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(photos.map((p) => p.id)));
    }
  }

  function handleAnalyzeSuccess() {
    setSelectedIds(new Set());
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">照片列表</h3>
            <span className="text-sm text-muted-foreground">
              第 {page} 页，共 {totalPages} 页
            </span>
            {selectedIds.size > 0 && (
              <span className="text-sm text-muted-foreground">已选 {selectedIds.size} 张</span>
            )}
            {isScanning && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                自动刷新中
              </span>
            )}
          </div>
          <AnalyzeTriggerButton
            photoIds={Array.from(selectedIds)}
            onSuccess={handleAnalyzeSuccess}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={selectedIds.size === photos.length && photos.length > 0}
            onChange={toggleAll}
            className="size-4 rounded border-gray-300"
          />
          <span className="text-sm text-muted-foreground">全选当前页</span>
        </div>

        <div className="divide-y rounded-lg border">
          {photos.map((photo) => (
            <div key={photo.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30">
              <input
                type="checkbox"
                checked={selectedIds.has(photo.id)}
                onChange={() => toggleSelect(photo.id)}
                className="size-4 rounded border-gray-300 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <p className="truncate font-mono text-xs">{photo.filePath}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {photo.width}x{photo.height}
                  </span>
                  <span>{(photo.fileSize / 1024 / 1024).toFixed(1)} MB</span>
                  <span>{new Date(photo.createdAt).toLocaleDateString("zh-CN")}</span>
                </div>
              </div>
              {photo.analysesCount > 0 ? (
                <Badge variant="default" className="text-xs shrink-0">
                  已分析
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground shrink-0">未分析</span>
              )}
            </div>
          ))}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-4">
            {page > 1 && (
              <Link
                href={`/admin/storage-sources/${storageSourceId}?page=${page - 1}`}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                上一页
              </Link>
            )}
            <span className="text-sm text-muted-foreground">
              {page} / {totalPages}
            </span>
            {page < totalPages && (
              <Link
                href={`/admin/storage-sources/${storageSourceId}?page=${page + 1}`}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                下一页
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
