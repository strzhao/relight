"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { API_ROUTES } from "@relight/shared";
import { ArrowLeft, MapPin } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ResultPhoto {
  path: string;
  outputPath: string;
  takenAt: string;
  tags: string[];
  inCluster: number;
  photoId: string | null;
  thumbnailPath: string | null;
  width: number;
  height: number;
}

interface TaskPhotosData {
  photos: ResultPhoto[];
  stats: {
    totalInWindow: number;
    clustersFound: number;
    selected: number;
    copied: number;
    failed: number;
  } | null;
  timeWindow: { start: string; end: string } | null;
  clusters: Array<{
    id: number;
    timeRange: { start: string; end: string };
    gpsCenter: { lat: number; lng: number } | null;
    isSelected: boolean;
  }> | null;
}

interface TaskRecord {
  id: string;
  pluginId: string;
  status: string;
  params: string | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default function TaskPhotosPage() {
  const routeParams = useParams();
  const pluginId = routeParams.pluginId as string;
  const taskId = routeParams.taskId as string;

  const [task, setTask] = useState<TaskRecord | null>(null);
  const [data, setData] = useState<TaskPhotosData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<ResultPhoto | null>(null);

  const fetchData = useCallback(async () => {
    try {
      // Fetch task detail + photos in parallel
      const [taskRes, photosRes] = await Promise.all([
        fetch(`${BASE_URL}${API_ROUTES.plugins.taskDetail(pluginId, taskId)}`),
        fetch(`${BASE_URL}${API_ROUTES.plugins.taskPhotos(pluginId, taskId)}`),
      ]);

      const taskBody = await taskRes.json();
      const photosBody = await photosRes.json();

      if (!taskBody.success) {
        setError(taskBody.error ?? "获取任务信息失败");
        return;
      }
      if (!photosBody.success) {
        setError(photosBody.error ?? "获取照片列表失败");
        return;
      }

      setTask(taskBody.data);
      setData(photosBody.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setLoading(false);
    }
  }, [pluginId, taskId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll if task is still running
  useEffect(() => {
    if (!task || task.status !== "running") return;
    const timer = setInterval(() => {
      fetchData();
    }, 3000);
    return () => clearInterval(timer);
  }, [task, fetchData]);

  const selectedCluster = data?.clusters?.find((c) => c.isSelected) ?? null;

  return (
    <div className="space-y-6" data-testid="photo-collection">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Link
          href={`/admin/plugins/${pluginId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          返回
        </Link>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">照片集合</span>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">{error}</span>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map(() => {
              const id = crypto.randomUUID();
              return <Skeleton key={id} className="aspect-square rounded-lg" />;
            })}
          </div>
        </div>
      ) : data ? (
        <>
          {/* Header info */}
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {data.timeWindow && (
                  <div>
                    <span className="text-xs text-muted-foreground">时间范围</span>
                    <p className="text-sm font-medium">
                      {new Date(data.timeWindow.start).toLocaleString("zh-CN")} ~{" "}
                      {new Date(data.timeWindow.end).toLocaleString("zh-CN")}
                    </p>
                  </div>
                )}
                {selectedCluster?.gpsCenter && (
                  <div>
                    <span className="text-xs text-muted-foreground">餐厅位置 (GPS)</span>
                    <p className="text-sm font-medium flex items-center gap-1">
                      <MapPin className="size-3" />
                      {selectedCluster.gpsCenter.lat.toFixed(4)},{" "}
                      {selectedCluster.gpsCenter.lng.toFixed(4)}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-xs text-muted-foreground">照片数量</span>
                  <p className="text-sm font-medium">{data.photos.length} 张</p>
                </div>
                {data.stats && (
                  <div>
                    <span className="text-xs text-muted-foreground">扫描统计</span>
                    <p className="text-sm font-medium">
                      窗口 {data.stats.totalInWindow} 张 / 聚类 {data.stats.clustersFound} 个 / 选中{" "}
                      {data.stats.selected} 张
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Photo grid */}
          {data.photos.length === 0 ? (
            <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
              {task?.status === "running" ? "任务运行中..." : "暂无照片"}
            </div>
          ) : (
            <div
              className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
              data-testid="photo-grid"
            >
              {data.photos.map((photo, idx) => (
                <button
                  key={photo.path}
                  type="button"
                  className="group relative aspect-square overflow-hidden rounded-lg border bg-muted cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
                  onClick={() => setSelectedPhoto(photo)}
                  data-testid="photo-item"
                >
                  {photo.photoId ? (
                    <Image
                      src={`${BASE_URL}${API_ROUTES.photos.thumbnail(photo.photoId)}`}
                      alt={`照片 ${idx + 1}`}
                      fill
                      sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="object-cover transition-transform group-hover:scale-105"
                      unoptimized
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-muted-foreground text-xs">
                      无缩略图
                    </div>
                  )}
                  {/* Tag chips overlay */}
                  {photo.tags.length > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 flex flex-wrap gap-1 p-2 bg-gradient-to-t from-black/60 to-transparent">
                      {photo.tags.slice(0, 3).map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 bg-white/20 text-white border-0"
                        >
                          {tag}
                        </Badge>
                      ))}
                      {photo.tags.length > 3 && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 bg-white/20 text-white border-0"
                        >
                          +{photo.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Lightbox dialog */}
          <Dialog
            open={!!selectedPhoto}
            onOpenChange={(open) => {
              if (!open) setSelectedPhoto(null);
            }}
          >
            <DialogContent className="max-w-[90vw] max-h-[90vh] p-0">
              {selectedPhoto?.photoId ? (
                <div className="relative w-full h-full flex items-center justify-center bg-black rounded-lg overflow-hidden">
                  <Image
                    src={`${BASE_URL}${API_ROUTES.photos.original(selectedPhoto.photoId)}`}
                    alt="原图"
                    width={selectedPhoto.width || 1200}
                    height={selectedPhoto.height || 800}
                    className="max-w-full max-h-[85vh] object-contain"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  无法加载原图
                </div>
              )}
              {selectedPhoto?.tags.length ? (
                <div className="flex flex-wrap gap-1.5 p-4">
                  {selectedPhoto.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
