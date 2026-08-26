import { execSync } from "node:child_process";
import "dotenv/config";
import path from "node:path";

/** 运行时解析 `which claude` 绝对路径（PM2 resurrect 时 nvm 不在 PATH，必须绝对路径） */
function resolveClaudeCliPath(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    // claude 未安装时返回空串，spawn 前存在校验会兜底 fail
    return "";
  }
}

export const config = {
  /** monorepo 根目录（child_process spawn cwd 用）。
   * ecosystem.config.cjs 启动 PM2 时显式注入 REPO_ROOT env；
   * dev `pnpm --filter @relight/backend dev` cwd=apps/backend，fallback ../.. 命中根 */
  repoRoot: process.env.REPO_ROOT ?? path.resolve(process.cwd(), "../.."),
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  /** 拾光 web app 常驻端口（默认 3601，worktree 通过 WEB_PORT env 覆盖） */
  webPort: Number.parseInt(process.env.WEB_PORT ?? "3601", 10),
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
  /** 每日精选定时任务自愈窗口：0:00 触发时先按升序补跑最近 N 天（不含今天）缺失的 dailyPicks，
   *  再跑今天。默认 7（覆盖宕机一周内自动恢复）；超大历史缺口仍需手动 backfill:daily-picks CLI。 */
  dailyAutoHealDays: Number.parseInt(process.env.DAILY_AUTO_HEAL_DAYS ?? "7", 10),
  /** 每日精选 select 评选阶段开关：在候选池构造后、narrate 之前调文本模型重排 hero。
   *  关闭时直接按 weightedScore desc 原序进入 narrate，零 AI 调用。 */
  dailySelectEnabled: (process.env.DAILY_SELECT_ENABLED ?? "true") === "true",
  /** 主力 4 源（historyToday / sameMonth / sameSeason / agedRandom）候选最低美学评分。
   *  fillUp 第 5 源保持更严的 ≥7.5 不变（见 candidate-pool.ts 硬编码）。 */
  minAestheticScorePrimary:
    Number.parseFloat(process.env.DAILY_SELECT_MIN_AESTHETIC_SCORE ?? "7.0") || 7.0,
  /** 腾讯云 COS + VPS 画廊配置（每日精选/视频产物推送公网画廊，见 state.md VPS 画廊设计）。
   *  凭据命名兼容（plan-reviewer 补强）：优先读 vps-ops 真源 `TENCENTCLOUD_SECRET_ID/SECRET_KEY/APPID/REGION`
   *  （bucket = `little-bee-assets-${APPID}`），fallback `COS_SECRET_ID/SECRET_KEY/BUCKET/REGION`。
   *  所有字段 env 注入，缺失时走默认值（本机开发不依赖画廊也能跑——画廊同步会 console.warn 旁路）。 */
  cos: {
    /** SecretId：优先 TENCENTCLOUD_SECRET_ID，fallback COS_SECRET_ID */
    secretId: process.env.TENCENTCLOUD_SECRET_ID ?? process.env.COS_SECRET_ID ?? "",
    /** SecretKey：优先 TENCENTCLOUD_SECRET_KEY，fallback COS_SECRET_KEY */
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY ?? process.env.COS_SECRET_KEY ?? "",
    /** Bucket：bucket = `little-bee-assets-${APPID}`；显式 COS_BUCKET 优先，否则按 APPID 拼，再 fallback 硬编码默认桶 */
    bucket:
      process.env.COS_BUCKET ??
      (process.env.TENCENTCLOUD_APPID
        ? `little-bee-assets-${process.env.TENCENTCLOUD_APPID}`
        : "little-bee-assets-1324334992"),
    /** 地域：优先 TENCENTCLOUD_REGION/COS_REGION，默认 ap-shanghai */
    region: process.env.TENCENTCLOUD_REGION ?? process.env.COS_REGION ?? "ap-shanghai",
    /** COS key 前缀（公有读桶下的子路径，默认 relight/） */
    prefix: process.env.COS_PREFIX ?? "relight",
  },
  /** VPS 画廊推送目标（SSH 免密 scp + ssh mv 原子覆盖 manifest.json） */
  gallery: {
    vpsHost: process.env.GALLERY_VPS_HOST ?? "43.143.124.222",
    vpsUser: process.env.GALLERY_VPS_USER ?? "ubuntu",
    vpsKey: process.env.GALLERY_VPS_KEY ?? "",
    vpsPath: process.env.GALLERY_VPS_PATH ?? "/home/ubuntu/relight-gallery",
  },
  /** 画廊公网基址（daily-video 推送 URL + 静态站首页；禁止硬编码 localhost） */
  galleryPublicUrl: process.env.GALLERY_PUBLIC_URL ?? "https://gallery.stringzhao.life",
  /** claude CLI 绝对路径（后端 spawn claude -p 调 memory-video skill）。
   *  env CLAUDE_CLI_PATH 覆盖；默认运行时 `which claude` 解析（PM2 resurrect 时 nvm 不在 PATH）。 */
  claudeCliPath: resolveClaudeCliPath(),
  /** Remotion 项目根（含 src/public/node_modules/render-immersive.mjs），claude -p 的 cwd。
   *  env VIDEO_WORKSPACE_PATH 覆盖；默认指向 <repo>/.autopilot 的 video-dryrun 目录。 */
  videoWorkspacePath:
    process.env.VIDEO_WORKSPACE_PATH ??
    path.join(
      process.env.REPO_ROOT ?? path.resolve(process.cwd(), "../.."),
      ".autopilot/runtime/requirements/20260725-每日视频生成/video-dryrun",
    ),
  /** spawn claude -p 视频生成超时（ms）。默认 45 分钟（实测 137 张素材渲染 29 分钟撞原
   *  30 分钟硬编码线被 SIGTERM，finalize 未执行）；cron 每天 10:00，45 分钟完成可接受。
   *  env VIDEO_SPAWN_TIMEOUT_MS 覆盖。 */
  videoSpawnTimeoutMs: Number.parseInt(process.env.VIDEO_SPAWN_TIMEOUT_MS ?? "2700000", 10),
  face: {
    /** 人物头像在 /photos 顶部展示的最低 memberCount 阈值 */
    displayThreshold: Number.parseInt(process.env.FACE_RECOGNITION_THRESHOLD ?? "5", 10),
    /**
     * @deprecated 语义变更为双阈值（方案 C）：mergeThreshold=0.7 / minThreshold=0.55。
     * 旧字段 clusteringThreshold=0.55 对应原"唯一阈值"，现拆分为两个语义不同的阈值，
     * 不是简单 alias，保留此注释说明语义升级。
     */
    clusteringThreshold: Number.parseFloat(process.env.FACE_CLUSTERING_THRESHOLD ?? "0.55"),
    /**
     * cosine >= 此值才完全跳过属性硬过滤直接合并。
     * 升级历史：0.7 → 0.85（patterns.md「centroid 雪球 + 垃圾桶 cluster」修复）。
     * 0.7 太宽松，让 cosine 0.7-0.85 的杂质（同色短发青年男女）绕过属性硬过滤进入大 cluster。
     */
    clusteringMergeThreshold: Number.parseFloat(
      process.env.FACE_CLUSTERING_MERGE_THRESHOLD ?? "0.85",
    ),
    /** cosine < 此值直接不合并（方案 C 下阈值） */
    clusteringMinThreshold: Number.parseFloat(process.env.FACE_CLUSTERING_MIN_THRESHOLD ?? "0.55"),
    /** [minThreshold, mergeThreshold) 区间是否启用属性硬过滤（true=全程过滤，0.85 后才直接合） */
    midZoneAttrFilter: (process.env.FACE_MID_ZONE_ATTR_FILTER ?? "true") === "true",
    /** Quality-aware 聚类：MED face 拉动 centroid 的权重（HIGH=1.0，LOW=0 不拉） */
    medQualityCentroidWeight: Number.parseFloat(
      process.env.FACE_MED_QUALITY_CENTROID_WEIGHT ?? "0.5",
    ),
    /**
     * Quality 阈值（bbox 尺寸 + detection_score 反推 quality 三级）：
     * - HIGH: bbox_w >= highBboxSize 且 detection_score >= highDetectionScore
     * - LOW: detection_score < lowDetectionScore（不论 bbox）
     * - MED: 其余
     */
    qualityHighBboxSize: Number.parseInt(process.env.FACE_QUALITY_HIGH_BBOX_SIZE ?? "200", 10),
    qualityHighDetectionScore: Number.parseFloat(
      process.env.FACE_QUALITY_HIGH_DETECTION_SCORE ?? "0.8",
    ),
    qualityLowDetectionScore: Number.parseFloat(
      process.env.FACE_QUALITY_LOW_DETECTION_SCORE ?? "0.65",
    ),
    /** 是否启用 qwen 属性分析（关闭时 attributes 始终为 null，退化为纯 cosine） */
    attributeAnalysisEnabled: (process.env.FACE_ATTRIBUTE_ANALYSIS ?? "true") === "true",
    /** 属性分析失败后的重试次数（共最多 retries+1 次调用） */
    attributeRetries: Number.parseInt(process.env.FACE_ATTRIBUTE_RETRIES ?? "1", 10),
    /** SCRFD 检测分数阈值 */
    detectionThreshold: Number.parseFloat(process.env.FACE_DETECTION_THRESHOLD ?? "0.5"),
    /** 最小人脸 bbox 边长（像素），过滤太小的脸 */
    minFaceSize: Number.parseInt(process.env.FACE_MIN_SIZE ?? "80", 10),
    /** 多原型：cosine >= 此值才合并到已有原型（tight merge） */
    prototypeTightMerge: Number.parseFloat(process.env.FACE_PROTOTYPE_TIGHT_MERGE ?? "0.88"),
    /**
     * 多原型：粗筛阈值，centroid cosine < 此值直接跳过该 person。
     * 默认 0.55 = clusteringMinThreshold（仅剔除零信号，不替代 mergeThreshold）。
     * 历史：设计稿曾设 0.70（= mergeThreshold-0.15），实证显示对 ArcFace MobileFaceNet
     * 边缘正例分布过严，会损失 ~19% 召回（cosine 0.55-0.70 真同人被剔除）。
     * 验收实测：阈值降到 0.55 后新方案 self-consistency 83.5% vs 单 centroid 78.7%，净增益 +261 张。
     */
    prototypeCoarseFilter: Number.parseFloat(process.env.FACE_PROTOTYPE_COARSE_FILTER ?? "0.55"),
    /** 多原型：每个 person 最多保留的原型数量 */
    prototypeMaxPerPerson: Number.parseInt(process.env.FACE_PROTOTYPE_MAX_PER_PERSON ?? "5", 10),
    /** 多原型：k-means 最大迭代次数 */
    prototypeKmeansMaxIters: Number.parseInt(
      process.env.FACE_PROTOTYPE_KMEANS_MAX_ITERS ?? "20",
      10,
    ),
  },
} as const;
