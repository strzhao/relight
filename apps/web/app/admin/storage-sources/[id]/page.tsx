import { AnalyzeTriggerButton } from "@/components/admin/analyze-trigger-button";
import { ScanTriggerButton } from "@/components/admin/scan-trigger-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { API_ROUTES } from "@relight/shared";
import type { StorageSource } from "@relight/shared";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { StorageSourcePhotosTable } from "./client";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function serverFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(body.error ?? "未知错误");
  return body.data as T;
}

interface StorageSourceDetail extends StorageSource {
  photoCount: number;
  analyzedCount: number;
}

interface PhotoRow {
  id: string;
  filePath: string;
  width: number;
  height: number;
  fileSize: number;
  createdAt: string;
  takenAt: string | null;
  analysesCount: number;
}

export default async function StorageSourceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page: pageParam } = await searchParams;
  const page = Number(pageParam) || 1;
  const pageSize = 20;

  let source: StorageSourceDetail | null = null;
  let photosData: { data: PhotoRow[]; total: number; page: number; pageSize: number } | null = null;
  let error: string | null = null;

  try {
    [source, photosData] = await Promise.all([
      serverFetch<StorageSourceDetail>(API_ROUTES.admin.storageSource(id)),
      serverFetch<{ data: PhotoRow[]; total: number; page: number; pageSize: number }>(
        `${API_ROUTES.admin.storageSourcePhotos(id)}?page=${page}&pageSize=${pageSize}`,
      ),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "获取数据失败";
  }

  const totalPages = photosData ? Math.ceil(photosData.total / pageSize) : 0;

  return (
    <div className="space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        返回仪表盘
      </Link>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
          </CardContent>
        </Card>
      )}

      {!source && !error && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      )}

      {source && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">{source.name}</h2>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {source.type}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{source.rootPath}</span>
                  </div>
                </div>
                <ScanTriggerButton storageSourceId={source.id} />
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
                    {source.lastScanAt
                      ? new Date(source.lastScanAt).toLocaleString("zh-CN")
                      : "从未"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {photosData && photosData.data.length > 0 ? (
            <StorageSourcePhotosTable
              photos={photosData.data}
              storageSourceId={id}
              page={page}
              totalPages={totalPages}
            />
          ) : photosData ? (
            <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
              该存储源下暂无照片，请先触发扫描
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
