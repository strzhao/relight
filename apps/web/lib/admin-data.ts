import type {
  AdminStats,
  HealthDetails,
  PhotoAnalysisItem,
  QueuesStatus,
  UnifiedPhotosResponse,
} from "@relight/shared";
import { API_ROUTES } from "@relight/shared";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/**
 * 服务端数据获取包装器
 * 使用 cache: "no-store" 确保每次获取最新数据
 */
async function serverFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Admin API Error: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();

  if (!body.success) {
    throw new Error(body.error ?? "未知错误");
  }

  return body.data as T;
}

/** 获取管理后台综合统计 */
export function getAdminStats(): Promise<AdminStats> {
  return serverFetch<AdminStats>(API_ROUTES.admin.stats);
}

/** 获取队列状态 */
export function getQueuesStatus(): Promise<QueuesStatus> {
  return serverFetch<QueuesStatus>(API_ROUTES.admin.queues);
}

/** 获取健康检查详情 */
export function getHealthDetails(): Promise<HealthDetails> {
  return serverFetch<HealthDetails>(API_ROUTES.admin.health);
}

/** 获取分页照片分析列表（旧版，保留兼容性） */
export function getPhotoAnalyses(
  page = 1,
  pageSize = 20,
  sortBy: "aestheticScore" | "processedAt" = "processedAt",
): Promise<{ data: PhotoAnalysisItem[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sortBy,
  });
  return serverFetch(`${API_ROUTES.admin.photos}?${params}`);
}

/** 统一照片列表查询参数 */
export interface UnifiedPhotosParams {
  page?: number;
  pageSize?: number;
  sortBy?: "createdAt" | "takenAt" | "fileSize" | "aestheticScore" | "processedAt";
  storageSourceId?: string;
  analysisStatus?: "all" | "analyzed" | "unanalyzed";
  minScore?: number;
}

/** 获取统一照片列表 */
export function getUnifiedPhotos(params: UnifiedPhotosParams): Promise<UnifiedPhotosResponse> {
  const sp = new URLSearchParams();
  if (params.page != null) sp.set("page", String(params.page));
  if (params.pageSize != null) sp.set("pageSize", String(params.pageSize));
  if (params.sortBy) sp.set("sortBy", params.sortBy);
  if (params.storageSourceId) sp.set("storageSourceId", params.storageSourceId);
  if (params.analysisStatus && params.analysisStatus !== "all")
    sp.set("analysisStatus", params.analysisStatus);
  if (params.minScore != null) sp.set("minScore", String(params.minScore));
  return serverFetch<UnifiedPhotosResponse>(`${API_ROUTES.admin.photos}?${sp.toString()}`);
}
