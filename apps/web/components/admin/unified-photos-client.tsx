"use client";

import { PhotoDetailPanel } from "@/components/admin/photo-detail-panel";
import { PhotoFilterBar } from "@/components/admin/photo-filter-bar";
import { PhotoGrid } from "@/components/admin/photo-grid";
import { ProgressPanel } from "@/components/admin/scan-progress-panel";
import { StorageSourceHeader } from "@/components/admin/storage-source-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { UnifiedPhotosResponse } from "@relight/shared";
import { RefreshCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface UnifiedPhotosClientProps {
  initialData: UnifiedPhotosResponse | null;
  initialError: string | null;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const PAGE_SIZE = 20;

export function UnifiedPhotosClient({ initialData, initialError }: UnifiedPhotosClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<UnifiedPhotosResponse | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [detailPhotoId, setDetailPhotoId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const page = Number(searchParams.get("page")) || 1;
  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  const fetchPhotos = useCallback(async () => {
    // 取消上一次请求
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams(searchParams.toString());
      if (!params.has("pageSize")) params.set("pageSize", String(PAGE_SIZE));

      const res = await fetch(`${BASE_URL}/api/admin/photos?${params.toString()}`, {
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`API Error: ${res.status} ${res.statusText}`);
      }

      const body = await res.json();
      if (!body.success) {
        throw new Error(body.error ?? "未知错误");
      }

      setData(body.data as UnifiedPhotosResponse);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "获取数据失败");
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  // 当 URL 参数变化时重新请求（但不影响首次渲染已经有的 initialData）
  useEffect(() => {
    fetchPhotos();
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [fetchPhotos]);

  const handlePhotoClick = useCallback((photoId: string) => {
    setDetailPhotoId(photoId);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailPhotoId(null);
  }, []);

  const handlePageChange = useCallback(
    (newPage: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPage));
      router.push(`/admin/photos?${params.toString()}`);
    },
    [router, searchParams],
  );

  const handleRefresh = useCallback(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  const storageSource = data?.storageSource ?? null;

  // 转换为 PhotoGrid 需要的数据格式
  const gridItems = (data?.data ?? []).map((photo) => ({
    id: photo.id,
    filePath: photo.filePath,
    thumbnailPath: photo.thumbnailPath,
    width: photo.width,
    height: photo.height,
    latestAnalysis: photo.latestAnalysis
      ? { aestheticScore: photo.latestAnalysis.aestheticScore }
      : null,
    analysesCount: photo.analysesCount,
  }));

  return (
    <div className="space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">照片管理</h2>
          <p className="text-sm text-muted-foreground">共 {data?.total ?? 0} 张照片</p>
        </div>
        <div className="flex items-center gap-2">
          <ProgressPanel
            mode="analyze"
            filterParams={{
              storageSourceId: searchParams.get("storageSourceId") || undefined,
              minScore: searchParams.get("minScore") || undefined,
            }}
            onAnalyzeComplete={handleRefresh}
          />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      {/* 错误横幅 */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 筛选栏 */}
      {data && <PhotoFilterBar storageSources={data.storageSources} total={data.total} />}

      {/* 存储源头部（仅在筛选特定存储源时显示） */}
      {storageSource && <StorageSourceHeader storageSource={storageSource} />}

      {/* 照片网格 / 加载骨架 */}
      {loading && !data ? (
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : data ? (
        <>
          <PhotoGrid photos={gridItems} onPhotoClick={handlePhotoClick} />

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => handlePageChange(page - 1)}
              >
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      ) : null}

      {/* 照片详情侧边面板 */}
      {detailPhotoId && (
        <PhotoDetailPanel
          photoId={detailPhotoId}
          open={!!detailPhotoId}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}
