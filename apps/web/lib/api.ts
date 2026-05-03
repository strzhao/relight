import type {
  AnalyzeTriggerResponse,
  ApiResponse,
  DailyPick,
  FileTreeResponse,
  PaginatedResponse,
  Photo,
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
    list: (params?: URLSearchParams) =>
      fetchApi<PaginatedResponse<Photo>>(`${API_ROUTES.photos.list}?${params ?? ""}`),
    detail: (id: string) => fetchApi<ApiResponse<Photo>>(API_ROUTES.photos.detail(id)),
  },

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
