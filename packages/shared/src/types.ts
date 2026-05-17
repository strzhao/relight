/** ===== 方案 C：人脸语义属性类型 ===== */

/** 人脸属性（v1，qwen 分析输出，固定枚举 + unknown 兜底） */
export type FaceAttributes = {
  schema_version: 1;
  age_band: "infant" | "child" | "teen" | "young_adult" | "middle_aged" | "senior" | "unknown";
  gender: "male" | "female" | "unknown";
  /** covered = 帽子/头巾 */
  hair: "long" | "short" | "bald" | "covered" | "unknown";
  glasses: "none" | "normal" | "sunglasses" | "unknown";
  facial_hair: "none" | "stubble" | "beard" | "moustache" | "unknown";
  expression: "neutral" | "smile" | "laugh" | "sad" | "surprised" | "unknown";
};

/** Person 内所有 face attributes 的多数票聚合 */
export type PersonAttributeSummary = {
  schema_version: 1;
  gender_mode: FaceAttributes["gender"];
  age_band_mode: FaceAttributes["age_band"];
  /** 统计 attributes IS NOT NULL 的脸数（非 memberCount） */
  member_count_with_attr: number;
};

/** 标签类别 */
export type TagCategory = "scene" | "emotion" | "people" | "color" | "event" | "object" | "style";

/** 标签 */
export interface Tag {
  id: string;
  name: string;
  category: TagCategory;
  createdAt: string;
}

/** 媒体类型 */
export type MediaType = "image" | "video";

/** 照片（兼容图片和视频） */
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
  // 视频支持：DB 层面 NOT NULL DEFAULT 'image'，TS 层面可选以保持向后兼容（缺省视为 'image'）
  mediaType?: MediaType;
  durationSec?: number | null;
  videoCodec?: string | null;
  videoFps?: number | null;
  // 连拍支持：burstId 非空时表示属于某个连拍组
  burstId?: string | null;
  isBurstRepresentative?: boolean;
  /** API 计算字段：1=单图，>1=连拍组代表（含成员数量） */
  burstSize?: number;
  tags?: PhotoTag[];
  analyses?: PhotoAnalysis[];
}

/** 人物（人脸聚类组） */
export interface Person {
  id: string;
  storageSourceId: string;
  name: string | null;
  nickname: string | null;
  bio: string | null;
  representativeFaceId: string | null;
  avatarPath: string | null;
  customAvatarPath: string | null;
  memberCount: number;
  manualOverride: boolean;
  displayable: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  /** 是否为「我自己」（拍照人/看精选的人）。派生自 settings.selfPersonId */
  isSelf: boolean;
  /** 方案 C：person 内 face attributes 的多数票聚合，可为 null */
  attributeSummary?: PersonAttributeSummary | null;
}

/** 人脸（每张人脸独立行） */
export interface Face {
  id: string;
  photoId: string;
  personId: string | null;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  detectionScore: number;
  detectedAt: string;
  /** 方案 C：qwen 语义属性，可为 null */
  attributes?: FaceAttributes | null;
}

/** 人物详情（含成员照片 + 全部 face） */
export interface PersonWithMembers extends Person {
  /** 该人物所有照片，按 takenAt desc */
  photos: Photo[];
  /** 该人物所有人脸（含 photoId+bbox），用于"选代表头像"UI */
  faces: Face[];
}

/** 连拍组 */
export interface Burst {
  id: string;
  storageSourceId: string;
  representativePhotoId: string | null;
  memberCount: number;
  manualOverride: boolean;
  createdAt: string;
}

/** 连拍组（含成员列表） */
export interface BurstWithMembers extends Burst {
  members: Photo[];
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
  // 视频专属字段（图片分析时为 NULL）
  transcript?: string | null;
  transcriptSegments?: { start: number; end: number; text: string }[] | null;
  videoPacing?: string | null;
  motionScore?: number | null;
}

/** 每日精选关联照片 */
export interface DailyPickMember {
  photoId: string;
  caption: string;
  photo?: Photo;
}

/** 每日精选单条入选记录（对应 daily_pick_entries 表行） */
export interface DailyPickEntry {
  rank: number;
  photoId: string;
  title: string;
  narrative: string;
  score: number;
  photo: Photo;
  members: (DailyPickMember & { photo: Photo })[];
}

/** 每日精选 */
export interface DailyPick {
  id: string;
  photoId: string;
  pickDate: string;
  title: string;
  narrative: string;
  score: number;
  composedImageUrl?: string | null;
  createdAt: string;
  photo?: Photo;
  /** 关联兄弟照片，最多 8 张，可能为空数组 */
  members: DailyPickMember[];
  /**
   * 今日所有入选照片（最多 20 张），按 rank ASC 排序。
   * GET /api/daily/today 和 GET /api/daily/:pickDate 响应中始终存在（可为空数组）。
   * 契约要求必填；非 API 路径（如 wallpaper composer）使用 Omit<DailyPick, 'entries'>。
   */
  entries: DailyPickEntry[];
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
  progress?: number | object | null;
}

/** 队列作业详情（含 data 和 stacktrace） */
export interface QueueJobDetail extends Omit<QueueJobSummary, "progress"> {
  data: unknown;
  progress: ScanProgress | number | object | null;
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
  mediaType?: MediaType;
  durationSec?: number | null;
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

/** 批量分析触发响应 */
export interface AnalyzeBatchResponse {
  batchId: string;
  totalCount: number;
  skippedCount: number;
}

/** 批量分析进度事件 */
export interface AnalyzeBatchProgressEvent {
  batchId: string;
  status: "running" | "completed" | "stale";
  totalCount: number;
  completedCount: number;
  failedCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/** 服务运行状态（Mac App 控制中心使用） */
export type ServiceStatus = "running" | "degraded" | "down";

export interface RuntimeStatus {
  overall: ServiceStatus;
  version: string;
  services: {
    api: {
      status: ServiceStatus;
      port: number;
      uptimeSec: number;
      pid: number | null;
    };
    workers: {
      status: ServiceStatus;
      lastHeartbeatAgoSec: number | null;
      commit: string | null;
      queueDepth: {
        scan: number;
        analyze: number;
        daily: number;
        faces: number;
      } | null;
    };
    redis: {
      status: ServiceStatus;
      latencyMs: number | null;
    };
    cron: {
      status: ServiceStatus;
      lastDailyPickDate: string | null;
      nextRunAt: string | null;
    };
  };
  repository: {
    photoCount: number;
    todayAdded: number;
    pendingAnalysis: number;
    storageBytes: number | null;
  } | null;
}

export type WorkerAction = "start" | "stop" | "reload";

export interface WorkerControlResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Workers PM2 日志（tail 最后 N 行） */
export interface WorkersLogs {
  stdout: string[];
  stderr: string[];
}

/** 运行时配置（只读，敏感字段已掩码） */
export interface RuntimeConfig {
  storageRoot: string;
  aiBaseUrl: string;
  aiModel: string;
  aiVisionModel: string;
  redisUrl: string;
  databasePath: string;
  bullmqPrefix: string;
  /** 已掩码，如 "sk-****abcd" 或 "****" */
  aiApiKey: string;
}
