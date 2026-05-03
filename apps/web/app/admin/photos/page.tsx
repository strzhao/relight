import { UnifiedPhotosClient } from "@/components/admin/unified-photos-client";
import { type UnifiedPhotosParams, getUnifiedPhotos } from "@/lib/admin-data";
import type { UnifiedPhotosResponse } from "@relight/shared";

interface PhotosPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPhotosPage({ searchParams }: PhotosPageProps) {
  const sp = await searchParams;

  const params: UnifiedPhotosParams = {
    page: sp.page ? Number(sp.page) : 1,
    pageSize: 20,
    sortBy: (sp.sortBy as UnifiedPhotosParams["sortBy"]) || "createdAt",
    storageSourceId: sp.storageSourceId as string | undefined,
    analysisStatus: (sp.analysisStatus as UnifiedPhotosParams["analysisStatus"]) || "all",
    minScore: sp.minScore ? Number(sp.minScore) : undefined,
  };

  let data: UnifiedPhotosResponse | null = null;
  let error: string | null = null;

  try {
    data = await getUnifiedPhotos(params);
  } catch (err) {
    error = err instanceof Error ? err.message : "获取照片列表失败";
  }

  return <UnifiedPhotosClient initialData={data} initialError={error} />;
}
