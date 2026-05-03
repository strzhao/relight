export const API_ROUTES = {
  health: "/api/health",
  photos: {
    list: "/api/photos",
    detail: (id: string) => `/api/photos/${id}`,
    thumbnail: (id: string) => `/api/photos/${id}/thumbnail`,
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
    storageSource: (id: string) => `/api/admin/storage-sources/${id}`,
    storageSourcePhotos: (id: string) => `/api/admin/storage-sources/${id}/photos`,
  },
  queues: {
    list: "/api/queues",
    events: (name: string) => `/api/queues/${name}/events`,
    job: (name: string, jobId: string) => `/api/queues/${name}/jobs/${jobId}`,
  },
  storage: {
    list: "/api/storage",
    files: (id: string) => `/api/storage/${id}/files`,
  },
  analyze: {
    trigger: "/api/analyze",
  },
} as const;
