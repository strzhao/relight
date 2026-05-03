export const API_ROUTES = {
  health: "/api/health",
  photos: {
    list: "/api/photos",
    detail: (id: string) => `/api/photos/${id}`,
    thumbnail: (id: string) => `/api/photos/${id}/thumbnail`,
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
  },
  settings: {
    list: "/api/settings",
    update: "/api/settings",
  },
  queues: {
    list: "/api/queues",
    events: (name: string) => `/api/queues/${name}/events`,
    job: (name: string, jobId: string) => `/api/queues/${name}/jobs/${jobId}`,
  },
} as const;
