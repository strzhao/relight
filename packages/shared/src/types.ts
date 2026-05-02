/** 标签类别 */
export type TagCategory = "scene" | "emotion" | "people" | "color" | "event" | "object" | "style";

/** 标签 */
export interface Tag {
  id: string;
  name: string;
  category: TagCategory;
  createdAt: string;
}

/** 照片 */
export interface Photo {
  id: string;
  storageSourceId: string;
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string | null;
  takenAt: string | null;
  createdAt: string;
  tags?: PhotoTag[];
  analyses?: PhotoAnalysis[];
}

/** 照片-标签关联 */
export interface PhotoTag {
  photoId: string;
  tagId: string;
  tagName?: string;
  tagCategory?: TagCategory;
  confidence: number;
}

/** AI 分析标签 */
export interface AnalysisTag {
  name: string;
  category: TagCategory;
  confidence: number;
}

/** 构图分析 */
export interface CompositionAnalysis {
  type: string;
  score: number;
  description: string;
}

/** 色彩分析 */
export interface ColorAnalysis {
  palette: string[];
  dominant: string;
  mood: string;
}

/** 情感分析 */
export interface EmotionalAnalysis {
  primary: string;
  secondary: string;
  intensity: number;
}

/** AI 分析记录 */
export interface PhotoAnalysis {
  id: string;
  photoId: string;
  aiModel: string;
  narrative?: string | null;
  aestheticScore?: number | null;
  tags?: AnalysisTag[] | null;
  composition?: CompositionAnalysis | null;
  colorAnalysis?: ColorAnalysis | null;
  emotionalAnalysis?: EmotionalAnalysis | null;
  usageSuggestions?: string | null;
  promptVersion?: string | null;
  rawResponse: string;
  processedAt: string;
}

/** 每日精选 */
export interface DailyPick {
  id: string;
  photoId: string;
  pickDate: string;
  title: string;
  narrative: string;
  score: number;
  createdAt: string;
  photo?: Photo;
}

/** 存储源 */
export interface StorageSource {
  id: string;
  name: string;
  type: "local" | "smb" | "webdav";
  rootPath: string;
  enabled: boolean;
  lastScanAt: string | null;
}

/** 扫描日志 */
export interface ScanLog {
  id: string;
  storageSourceId: string;
  scannedCount: number;
  newCount: number;
  errorCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/** API 响应包装 */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 带计数标签 */
export interface TagWithCount extends Tag {
  photoCount: number;
}

/** ===== Admin Panel Types ===== */

/** 存储源统计 */
export interface StorageSourceStats {
  id: string;
  name: string;
  type: "local" | "smb" | "webdav";
  photoCount: number;
  analyzedCount: number;
  lastScanAt: string | null;
}

/** 管理后台综合统计 */
export interface AdminStats {
  totalPhotos: number;
  analyzedPhotos: number;
  avgAestheticScore: number;
  passRate: number;
  storageSources: StorageSourceStats[];
  recentAnalyses: {
    id: string;
    filePath: string;
    aiModel: string;
    aestheticScore: number | null;
    narrative: string | null;
    processedAt: string;
  }[];
}

/** 单个队列状态 */
export interface QueueStatus {
  name: string;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
}

/** 所有队列状态 */
export type QueuesStatus = QueueStatus[];

/** 健康检查组件状态 */
export interface HealthComponentStatus {
  component: string;
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
}

/** 健康检查详情 */
export interface HealthDetails {
  overall: "healthy" | "degraded" | "unhealthy";
  components: HealthComponentStatus[];
}

/** 照片分析列表项 */
export interface PhotoAnalysisItem {
  id: string;
  filePath: string;
  aiModel: string;
  aestheticScore: number | null;
  narrative: string | null;
  processedAt: string;
}
