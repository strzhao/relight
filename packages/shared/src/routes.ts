export const API_ROUTES = {
  health: "/api/health",
  runtime: {
    status: "/api/runtime/status",
  },
  photos: {
    list: "/api/photos",
    detail: (id: string) => `/api/photos/${id}`,
    thumbnail: (id: string) => `/api/photos/${id}/thumbnail`,
    original: (id: string) => `/api/photos/${id}/original`,
    raw: (id: string) => `/api/photos/${id}/raw`,
    subtitles: (id: string) => `/api/photos/${id}/subtitles.vtt`,
    analyze: "/api/photos/analyze",
  },
  daily: {
    today: "/api/daily/today",
    list: "/api/daily",
    detail: (id: string) => `/api/daily/${id}`,
  },
  tags: {
    list: "/api/tags",
  },
  scan: {
    trigger: "/api/scan",
    status: (id: string) => `/api/scan/${id}`,
    events: (id: string) => `/api/scan/${id}/events`,
  },
  settings: {
    list: "/api/settings",
    update: "/api/settings",
  },
  admin: {
    stats: "/api/admin/stats",
    queues: "/api/admin/queues",
    health: "/api/admin/health",
    photos: "/api/admin/photos",
    photosAnalyze: "/api/admin/photos/analyze",
    photosAnalyzeEvents: (batchId: string) => `/api/admin/photos/analyze/${batchId}/events`,
    storageSource: (id: string) => `/api/admin/storage-sources/${id}`,
    storageSourcePhotos: (id: string) => `/api/admin/storage-sources/${id}/photos`,
  },
  queues: {
    list: "/api/queues",
    events: (name: string) => `/api/queues/${name}/events`,
    job: (name: string, jobId: string) => `/api/queues/${name}/jobs/${jobId}`,
    retryFailed: (name: string) => `/api/queues/${name}/retry-failed`,
  },
  storage: {
    list: "/api/storage",
    files: (id: string) => `/api/storage/${id}/files`,
    check: (id: string) => `/api/storage/${id}/check`,
  },
  analyze: {
    trigger: "/api/analyze",
    jobEvents: (jobId: string) => `/api/analyze/jobs/${jobId}/events`,
  },
  bursts: {
    members: (id: string) => `/api/bursts/${id}/members`,
    representative: (id: string) => `/api/bursts/${id}/representative`,
  },
  persons: {
    list: "/api/persons",
    detail: (id: string) => `/api/persons/${id}`,
    update: (id: string) => `/api/persons/${id}`,
    representative: (id: string) => `/api/persons/${id}/representative`,
    merge: (id: string) => `/api/persons/${id}/merge`,
    avatarUpload: (id: string) => `/api/persons/${id}/avatar`,
    avatarImage: (id: string) => `/api/persons/${id}/avatar.jpg`,
  },
} as const;
