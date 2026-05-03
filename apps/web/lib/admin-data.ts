import type { AdminStats, HealthDetails, PhotoAnalysisItem, QueuesStatus } from "@relight/shared";
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

/** 获取分页照片分析列表 */
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
