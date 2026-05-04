import type {
  AdminStats,
  AnalyzeBatchResponse,
  AnalyzeTriggerResponse,
  ApiResponse,
  DailyPick,
  FileTreeResponse,
  HealthDetails,
  PaginatedResponse,
  Photo,
  PhotoAnalysisItem,
  QueueInfo,
  QueueJobDetail,
  QueuesStatus,
  ScanLog,
  StorageSource,
  Tag,
} from "@relight/shared";
import { API_ROUTES } from "@relight/shared";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API Error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetchApi<{ status: string }>(API_ROUTES.health),

  photos: {
    list: (params?: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      order?: string;
      tagId?: string;
      storageSourceId?: string;
      dateFrom?: string;
      dateTo?: string;
    }) => {
      const searchParams = new URLSearchParams();
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) {
            searchParams.set(key, String(value));
          }
        }
      }
      return fetchApi<PaginatedResponse<Photo>>(
        `${API_ROUTES.photos.list}?${searchParams.toString()}`,
      );
    },
    detail: (id: string) => fetchApi<ApiResponse<Photo>>(API_ROUTES.photos.detail(id)),
    analyze: (photoIds: string[]) =>
      fetchApi<ApiResponse<{ enqueued: number }>>(API_ROUTES.photos.analyze, {
        method: "POST",
        body: JSON.stringify({ photoIds }),
      }),
  },

  /** Build the full thumbnail URL for a photo */
  thumbnailUrl: (id: string) => `${BASE_URL}${API_ROUTES.photos.thumbnail(id)}`,

  daily: {
    today: () => fetchApi<ApiResponse<DailyPick>>(API_ROUTES.daily.today),
    list: (params?: URLSearchParams) =>
      fetchApi<PaginatedResponse<DailyPick>>(`${API_ROUTES.daily.list}?${params ?? ""}`),
  },

  tags: {
    list: () => fetchApi<ApiResponse<Tag[]>>(API_ROUTES.tags.list),
  },

  scan: {
    trigger: (storageSourceId?: string, skipAnalysis?: boolean) =>
      fetchApi<ApiResponse<{ jobId: string | undefined; storageSourceId: string }>>(
        API_ROUTES.scan.trigger,
        {
          method: "POST",
          body: JSON.stringify({ storageSourceId, skipAnalysis }),
        },
      ),
  },

  settings: {
    get: () => fetchApi<ApiResponse<Record<string, string>>>(API_ROUTES.settings.list),
    update: (key: string, value: string) =>
      fetchApi<ApiResponse<Record<string, string>>>(API_ROUTES.settings.update, {
        method: "PUT",
        body: JSON.stringify({ key, value }),
      }),
  },

  admin: {
    stats: () => fetchApi<ApiResponse<AdminStats>>(API_ROUTES.admin.stats),
    queues: () => fetchApi<ApiResponse<QueuesStatus>>(API_ROUTES.admin.queues),
    health: () => fetchApi<ApiResponse<HealthDetails>>(API_ROUTES.admin.health),
    photos: (params?: URLSearchParams) =>
      fetchApi<PaginatedResponse<PhotoAnalysisItem>>(`${API_ROUTES.admin.photos}?${params ?? ""}`),
    analyzeBatch: (params: {
      storageSourceId?: string;
      minScore?: string;
      force?: boolean;
    }) =>
      fetchApi<ApiResponse<AnalyzeBatchResponse>>(API_ROUTES.admin.photosAnalyze, {
        method: "POST",
        body: JSON.stringify(params),
      }),
  },

  queues: {
    list: () => fetchApi<ApiResponse<QueueInfo[]>>(API_ROUTES.queues.list),
    job: (name: string, jobId: string) =>
      fetchApi<ApiResponse<QueueJobDetail>>(API_ROUTES.queues.job(name, jobId)),
  },

  storage: {
    list: () => fetchApi<ApiResponse<StorageSource[]>>(API_ROUTES.storage.list),
    files: (id: string) => fetchApi<ApiResponse<FileTreeResponse>>(API_ROUTES.storage.files(id)),
  },

  analyze: {
    trigger: (photoIds: string[], force?: boolean) =>
      fetchApi<ApiResponse<AnalyzeTriggerResponse>>(API_ROUTES.analyze.trigger, {
        method: "POST",
        body: JSON.stringify({ photoIds, force }),
      }),
  },
};
