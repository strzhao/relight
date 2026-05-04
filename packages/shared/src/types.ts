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

/** 存储源可达性状态 */
export type StorageSourceStatus =
  | "unknown"
  | "healthy"
  | "inaccessible"
  | "unmounted"
  | "permission_denied";

/** 存储源 */
export interface StorageSource {
  id: string;
  name: string;
  type: "local" | "smb" | "webdav";
  rootPath: string;
  enabled: boolean;
  lastScanAt: string | null;
  status?: StorageSourceStatus;
  lastError?: string | null;
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
  status?: StorageSourceStatus;
  lastError?: string | null;
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

/** 系统资源信息 */
export interface SystemInfo {
  cpu: { model: string; cores: number; loadAvg: number[] };
  memory: { total: number; free: number; used: number; usagePercent: number };
  process: {
    pid: number;
    uptime: number;
    nodeVersion: string;
    memoryRss: number;
    memoryHeapTotal: number;
    memoryHeapUsed: number;
  };
}

/** 磁盘信息 */
export interface DiskInfo {
  dbFile: { path: string; sizeBytes: number };
  freeSpaceBytes: number | null;
  totalSpaceBytes: number | null;
}

/** 健康检查详情 */
export interface HealthDetails {
  overall: "healthy" | "degraded" | "unhealthy";
  components: HealthComponentStatus[];
  system: SystemInfo;
  disk: DiskInfo | null;
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

/** ===== Queue Monitor Types ===== */

/** 队列作业计数 */
export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

/** 队列作业摘要 */
export interface QueueJobSummary {
  id: string;
  name: string;
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "paused" | "unknown";
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string | null;
  progress?: ScanProgress | null;
}

/** 队列作业详情（含 data 和 stacktrace） */
export interface QueueJobDetail extends Omit<QueueJobSummary, "progress"> {
  data: unknown;
  progress: number | object;
  returnvalue: unknown;
  opts: Record<string, unknown>;
  stacktrace: string[];
}

/** 队列快照（SSE 推送） */
export interface QueueSnapshot {
  timestamp: string;
  counts: QueueJobCounts;
  recentJobs: QueueJobSummary[];
  aggregateProgress?: {
    totalFiles: number;
    processed: number;
    newCount: number;
    skippedCount: number;
    errorCount: number;
    updatedCount: number;
    regeneratedCount: number;
  } | null;
}

/** 队列信息（侧边栏） */
export interface QueueInfo {
  name: string;
  label: string;
  description: string;
  isActive: boolean;
  badge: string | null;
  counts: QueueJobCounts | null;
}

/** ===== File Tree & Analysis Types ===== */

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

/** 扫描进度（BullMQ job.progress 结构） */
export interface ScanProgress {
  phase: "listing" | "hashing" | "processing" | "completed";
  totalFiles: number;
  processed: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  regeneratedCount: number;
  currentFile?: string;
}

/** SSE 推送的扫描进度事件 */
export interface ScanProgressEvent {
  scanLogId: string;
  status: "running" | "completed" | "failed" | "stale";
  phase: ScanProgress["phase"] | null;
  totalFiles: number;
  processed: number;
  newCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  regeneratedCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/** 扫描触发响应 */
export interface ScanTriggerResponse {
  jobId: string | undefined;
  scanLogId: string;
  storageSourceId: string;
}

/** 统一照片列表项 */
export interface UnifiedPhotoItem {
  id: string;
  storageSourceId: string;
  filePath: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string | null;
  takenAt: string | null;
  createdAt: string;
  latestAnalysis: {
    id: string;
    aiModel: string;
    aestheticScore: number | null;
    narrative: string | null;
    processedAt: string;
  } | null;
  analysesCount: number;
}

/** 统一照片列表响应 */
export interface UnifiedPhotosResponse {
  data: UnifiedPhotoItem[];
  total: number;
  page: number;
  pageSize: number;
  storageSources: { id: string; name: string }[];
  storageSource?: {
    id: string;
    name: string;
    type: "local" | "smb" | "webdav";
    rootPath: string;
    enabled: boolean;
    lastScanAt: string | null;
    status?: StorageSourceStatus;
    lastError?: string | null;
    photoCount: number;
    analyzedCount: number;
  };
}
