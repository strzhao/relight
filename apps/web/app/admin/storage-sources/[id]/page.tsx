import { API_ROUTES } from "@relight/shared";
import type { StorageSource } from "@relight/shared";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { DetailClient } from "./detail-client";
import type { PhotoRow } from "./types";

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
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-center">
          <span className="text-destructive text-sm">获取数据失败：{error}</span>
        </div>
      )}

      {!source && !error && (
        <div className="space-y-4">
          <div className="h-40 w-full rounded-lg bg-muted animate-pulse" />
          <div className="h-64 w-full rounded-lg bg-muted animate-pulse" />
        </div>
      )}

      {source && (
        <DetailClient
          source={source}
          initialPhotos={photosData?.data ?? []}
          storageSourceId={id}
          page={page}
          totalPages={totalPages}
        />
      )}
    </div>
  );
}
