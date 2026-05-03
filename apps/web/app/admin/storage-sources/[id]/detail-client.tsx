"use client";

import { ScanProgressPanel } from "@/components/admin/scan-progress-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { StorageSourcePhotosTable } from "./client";
import type { PhotoRow } from "./types";

interface StorageSourceDetail {
  id: string;
  name: string;
  type: "local" | "smb" | "webdav";
  rootPath: string;
  enabled: boolean;
  lastScanAt: string | null;
  photoCount: number;
  analyzedCount: number;
}

interface DetailClientProps {
  source: StorageSourceDetail;
  initialPhotos: PhotoRow[];
  storageSourceId: string;
  page: number;
  totalPages: number;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export function DetailClient({
  source,
  initialPhotos,
  storageSourceId,
  page,
  totalPages,
}: DetailClientProps) {
  const router = useRouter();
  const [isScanning, setIsScanning] = useState(false);
  const [photos, setPhotos] = useState<PhotoRow[]>(initialPhotos);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/api/admin/storage-sources/${storageSourceId}/photos?page=${page}&pageSize=20`,
        );
        const body = await res.json();
        if (body.success && body.data) {
          setPhotos(body.data.data ?? body.data);
        }
      } catch {
        // 轮询失败忽略
      }
    }, 3000);
  }, [storageSourceId, page]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleScanStart = useCallback(() => {
    setIsScanning(true);
    startPolling();
  }, [startPolling]);

  const handleScanComplete = useCallback(() => {
    setIsScanning(false);
    stopPolling();
    router.refresh();
  }, [stopPolling, router]);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold">{source.name}</h2>
                <Badge variant="secondary" className="text-xs">
                  {source.type}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{source.rootPath}</p>
            </div>
            <ScanProgressPanel
              storageSourceId={storageSourceId}
              onScanStart={handleScanStart}
              onScanComplete={handleScanComplete}
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">照片总数</span>
              <p className="text-lg font-semibold">{source.photoCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">已分析</span>
              <p className="text-lg font-semibold">{source.analyzedCount}</p>
            </div>
            <div>
              <span className="text-muted-foreground">覆盖率</span>
              <p className="text-lg font-semibold">
                {source.photoCount > 0
                  ? Math.round((source.analyzedCount / source.photoCount) * 100)
                  : 0}
                %
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">最后扫描</span>
              <p className="text-lg font-semibold text-sm">
                {source.lastScanAt ? new Date(source.lastScanAt).toLocaleString("zh-CN") : "从未"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {photos.length > 0 ? (
        <StorageSourcePhotosTable
          photos={photos}
          storageSourceId={storageSourceId}
          page={page}
          totalPages={totalPages}
          isScanning={isScanning}
        />
      ) : (
        <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          该存储源下暂无照片，请先触发扫描
        </div>
      )}
    </>
  );
}
