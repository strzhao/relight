import type {
  AdminStats,
  AnalyzeBatchResponse,
  AnalyzeTriggerResponse,
  ApiResponse,
  Burst,
  DailyPick,
  FileTreeResponse,
  HealthDetails,
  MergePerson,
  PaginatedResponse,
  Person,
  PersonWithMembers,
  Photo,
  PhotoAnalysisItem,
  QueueInfo,
  QueueJobDetail,
  QueuesStatus,
  ScanLog,
  SetPersonRepresentative,
  StorageSource,
  Tag,
  UpdatePerson,
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

/** Build a full URL by prefixing the API base. Test-mockable as a flat export. */
export function getApiUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

/** Today's daily pick. Flat export for test mocking. */
export function getTodayPick() {
  return fetchApi<ApiResponse<DailyPick>>(API_ROUTES.daily.today);
}

/** Daily pick by id. Flat export for test mocking. */
export function getDailyPick(id: string) {
  return fetchApi<ApiResponse<DailyPick>>(API_ROUTES.daily.detail(id));
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
    analyze: (photoIds: string[], force?: boolean) =>
      fetchApi<ApiResponse<{ enqueued: number; skippedCount: number }>>(API_ROUTES.photos.analyze, {
        method: "POST",
        body: JSON.stringify({ photoIds, force }),
      }),
  },

  /** Build the full thumbnail URL for a photo */
  thumbnailUrl: (id: string) => `${BASE_URL}${API_ROUTES.photos.thumbnail(id)}`,

  /** Build the full-resolution original URL for a photo (HEIC is server-side decoded to JPEG) */
  originalUrl: (id: string) => `${BASE_URL}${API_ROUTES.photos.original(id)}`,

  /** Build the raw streaming URL — supports HTTP Range, used for native <video> playback */
  rawUrl: (id: string) => `${BASE_URL}${API_ROUTES.photos.raw(id)}`,

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
    retryFailed: (name: string) =>
      fetchApi<ApiResponse<{ retried: number; failed: number; total: number }>>(
        API_ROUTES.queues.retryFailed(name),
        { method: "POST" },
      ),
  },

  storage: {
    list: () => fetchApi<ApiResponse<StorageSource[]>>(API_ROUTES.storage.list),
    files: (id: string) => fetchApi<ApiResponse<FileTreeResponse>>(API_ROUTES.storage.files(id)),
    check: (id: string) =>
      fetchApi<ApiResponse<{ id: string; status: string; lastError: string | null }>>(
        API_ROUTES.storage.check(id),
        { method: "POST" },
      ),
  },

  analyze: {
    trigger: (photoIds: string[], force?: boolean) =>
      fetchApi<ApiResponse<AnalyzeTriggerResponse>>(API_ROUTES.analyze.trigger, {
        method: "POST",
        body: JSON.stringify({ photoIds, force }),
      }),
  },

  bursts: {
    /** 获取连拍组所有成员（按拍摄时间升序） */
    members: (id: string) =>
      fetchApi<{ success: boolean; data: Photo[]; burst: Burst }>(API_ROUTES.bursts.members(id)),
    /** 设置连拍代表照片（置 manualOverride=true） */
    setRepresentative: (id: string, photoId: string) =>
      fetchApi<
        ApiResponse<{ burstId: string; representativePhotoId: string; manualOverride: boolean }>
      >(API_ROUTES.bursts.representative(id), {
        method: "PATCH",
        body: JSON.stringify({ photoId }),
      }),
  },

  persons: {
    /** 列表（默认 displayable=true） */
    list: (params?: { storageSourceId?: string; displayable?: boolean }) => {
      const search = new URLSearchParams();
      if (params?.storageSourceId) search.set("storageSourceId", params.storageSourceId);
      if (params?.displayable === false) search.set("displayable", "false");
      const qs = search.toString();
      return fetchApi<ApiResponse<Person[]>>(
        qs ? `${API_ROUTES.persons.list}?${qs}` : API_ROUTES.persons.list,
      );
    },
    /** 详情（含成员照片 + 全部 face） */
    detail: (id: string) => fetchApi<ApiResponse<PersonWithMembers>>(API_ROUTES.persons.detail(id)),
    /** 更新 name / bio */
    update: (id: string, body: UpdatePerson) =>
      fetchApi<ApiResponse<Person>>(API_ROUTES.persons.update(id), {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    /** 设置代表 face（置 manualOverride=true） */
    setRepresentative: (id: string, body: SetPersonRepresentative) =>
      fetchApi<ApiResponse<Person>>(API_ROUTES.persons.representative(id), {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    /** 合并到目标 person */
    merge: (id: string, body: MergePerson) =>
      fetchApi<
        ApiResponse<{ mergedFromId: string; targetPersonId: string; newMemberCount: number }>
      >(API_ROUTES.persons.merge(id), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    /** 头像图片 URL（custom > auto > 404） */
    avatarUrl: (id: string) => `${BASE_URL}${API_ROUTES.persons.avatarImage(id)}`,
  },
};
