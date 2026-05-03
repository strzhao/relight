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

/** 分析状态枚举 */
export type AnalysisStatus = "pending" | "analyzed" | "failed";

/** 文件树节点 */
export interface FileTreeNode {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: FileTreeNode[];
  photoId?: string;
  fileSize?: number;
  analysisStatus?: AnalysisStatus;
}

/** 文件树响应 */
export interface FileTreeResponse {
  tree: FileTreeNode[];
  totalFiles: number;
  analyzedCount: number;
  pendingCount: number;
  failedCount: number;
}

/** 分析触发响应 */
export interface AnalyzeTriggerResponse {
  queuedCount: number;
  skippedCount: number;
  jobIds: string[];
}
