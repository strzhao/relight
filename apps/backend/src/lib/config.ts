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
  face: {
    /** 人物头像在 /photos 顶部展示的最低 memberCount 阈值 */
    displayThreshold: Number.parseInt(process.env.FACE_RECOGNITION_THRESHOLD ?? "5", 10),
    /** cosine 相似度归并阈值（>= 此值视为同一人） */
    clusteringThreshold: Number.parseFloat(process.env.FACE_CLUSTERING_THRESHOLD ?? "0.5"),
    /** SCRFD 检测分数阈值 */
    detectionThreshold: Number.parseFloat(process.env.FACE_DETECTION_THRESHOLD ?? "0.5"),
    /** 最小人脸 bbox 边长（像素），过滤太小的脸 */
    minFaceSize: Number.parseInt(process.env.FACE_MIN_SIZE ?? "80", 10),
  },
} as const;
