import "dotenv/config";

export const config = {
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  databasePath: process.env.DATABASE_PATH ?? "./data/relight.db",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  storageRoot: process.env.STORAGE_ROOT ?? "./photos",
  bullmqPrefix: process.env.BULLMQ_PREFIX ?? "bull",
  ai: {
    baseUrl: process.env.AI_BASE_URL ?? "http://127.0.0.1:8001/v1",
    apiKey: process.env.AI_API_KEY ?? "qwen-local-key",
    model: process.env.AI_MODEL ?? "qwen3.6-35b",
    visionModel: process.env.AI_VISION_MODEL ?? "qwen3.6-35b",
    promptVersion: process.env.AI_PROMPT_VERSION || "v2",
  },
  video: {
    enabled: process.env.VIDEO_ENABLED !== "false",
    frameCount: Number.parseInt(process.env.VIDEO_FRAME_COUNT ?? "6", 10),
    ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: process.env.FFPROBE_PATH ?? "ffprobe",
  },
  whisper: {
    enabled: process.env.WHISPER_ENABLED !== "false",
    python: process.env.WHISPER_PYTHON ?? "/Users/stringzhao/workspace/martin/.venv/bin/python3",
    script:
      process.env.WHISPER_SCRIPT ?? "/Users/stringzhao/workspace/martin/scripts/transcribe.py",
    engine: process.env.WHISPER_ENGINE ?? "mlx",
    model: process.env.WHISPER_MODEL ?? "large-v3-turbo",
    language: process.env.WHISPER_LANGUAGE ?? "auto",
  },
  /** 每日精选并行处理并发度（默认 2，可通过 DAILY_SELECTION_CONCURRENCY 环境变量调整） */
  dailySelectionConcurrency: Number.parseInt(process.env.DAILY_SELECTION_CONCURRENCY ?? "2", 10),
  face: {
    /** 人物头像在 /photos 顶部展示的最低 memberCount 阈值 */
    displayThreshold: Number.parseInt(process.env.FACE_RECOGNITION_THRESHOLD ?? "5", 10),
    /**
     * @deprecated 语义变更为双阈值（方案 C）：mergeThreshold=0.7 / minThreshold=0.55。
     * 旧字段 clusteringThreshold=0.55 对应原"唯一阈值"，现拆分为两个语义不同的阈值，
     * 不是简单 alias，保留此注释说明语义升级。
     */
    clusteringThreshold: Number.parseFloat(process.env.FACE_CLUSTERING_THRESHOLD ?? "0.55"),
    /** cosine >= 此值直接合并（方案 C 上阈值） */
    clusteringMergeThreshold: Number.parseFloat(
      process.env.FACE_CLUSTERING_MERGE_THRESHOLD ?? "0.7",
    ),
    /** cosine < 此值直接不合并（方案 C 下阈值） */
    clusteringMinThreshold: Number.parseFloat(process.env.FACE_CLUSTERING_MIN_THRESHOLD ?? "0.55"),
    /** 中间区间 [minThreshold, mergeThreshold) 是否启用属性硬过滤 */
    midZoneAttrFilter: (process.env.FACE_MID_ZONE_ATTR_FILTER ?? "true") === "true",
    /** 是否启用 qwen 属性分析（关闭时 attributes 始终为 null，退化为纯 cosine） */
    attributeAnalysisEnabled: (process.env.FACE_ATTRIBUTE_ANALYSIS ?? "true") === "true",
    /** 属性分析失败后的重试次数（共最多 retries+1 次调用） */
    attributeRetries: Number.parseInt(process.env.FACE_ATTRIBUTE_RETRIES ?? "1", 10),
    /** SCRFD 检测分数阈值 */
    detectionThreshold: Number.parseFloat(process.env.FACE_DETECTION_THRESHOLD ?? "0.5"),
    /** 最小人脸 bbox 边长（像素），过滤太小的脸 */
    minFaceSize: Number.parseInt(process.env.FACE_MIN_SIZE ?? "80", 10),
  },
} as const;
