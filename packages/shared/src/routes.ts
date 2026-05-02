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
  admin: {
    stats: "/api/admin/stats",
    queues: "/api/admin/queues",
    health: "/api/admin/health",
    photos: "/api/admin/photos",
  },
} as const;
