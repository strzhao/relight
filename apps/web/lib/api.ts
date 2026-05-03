import type {
  ApiResponse,
  DailyPick,
  PaginatedResponse,
  Photo,
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
    list: (params?: URLSearchParams) =>
      fetchApi<PaginatedResponse<Photo>>(`${API_ROUTES.photos.list}?${params ?? ""}`),
    detail: (id: string) => fetchApi<ApiResponse<Photo>>(API_ROUTES.photos.detail(id)),
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
    trigger: (storageSourceId?: string) =>
      fetchApi<ApiResponse<{ message: string }>>(API_ROUTES.scan.trigger, {
        method: "POST",
        body: JSON.stringify({ storageSourceId }),
      }),
  },

  settings: {
    get: () => fetchApi<ApiResponse<Record<string, string>>>(API_ROUTES.settings.list),
    update: (key: string, value: string) =>
      fetchApi<ApiResponse<Record<string, string>>>(API_ROUTES.settings.update, {
        method: "PUT",
        body: JSON.stringify({ key, value }),
      }),
  },
};
