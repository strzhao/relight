import { z } from "zod";
import { photoAnalysisResponseSchema } from "../../ai/response-parser";

export const mediaPersonSchema = z.object({
  personId: z.string(),
  name: z.string(),
  frameCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

export const mediaPersonsSchema = z.array(mediaPersonSchema);
export type MediaPerson = z.infer<typeof mediaPersonSchema>;
export type MediaPersonsStatus = "ok" | "no_faces" | "model_unavailable" | "db_unavailable";

const personsStatusSchema = z.enum(["ok", "no_faces", "model_unavailable", "db_unavailable"]);

export { photoAnalysisResponseSchema };
export type PhotoAnalysisResponse = z.infer<typeof photoAnalysisResponseSchema>;

export const frameCaptionSchema = z.object({
  tSec: z.number().nonnegative(),
  caption: z.string().min(1).max(500),
});
export type FrameCaption = z.infer<typeof frameCaptionSchema>;

export const videoAnalysisExtraSchema = z.object({
  videoNarrative: z.string().optional(),
  videoPacing: z.enum(["slow", "medium", "fast"]).optional(),
  motionScore: z.number().min(0).max(100).optional(),
  // 由 vlog-frame-extract + skill Claude 视觉生成；每 ~20s 一帧，时间锚定的画面描述
  // 不由 Qwen 一次性返回（Qwen 看 sprite 拼图给 narrative；这是 per-frame）
  frameCaptions: z.array(frameCaptionSchema).optional(),
});

export const videoAnalysisResponseSchema =
  photoAnalysisResponseSchema.merge(videoAnalysisExtraSchema);
export type VideoAnalysisResponse = z.infer<typeof videoAnalysisResponseSchema>;

const baseFileFields = z.object({
  ok: z.boolean(),
  filePath: z.string(),
  realPath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileSize: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  cacheHit: z.boolean(),
  error: z.string().optional(),
});

export const imageAnalysisResultSchema = baseFileFields.extend({
  type: z.literal("image"),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  phash: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  thumbnailPath: z.string().optional(),
  exif: z
    .object({
      takenAt: z.string().optional(),
    })
    .optional(),
  ai: photoAnalysisResponseSchema.optional(),
  promptVersion: z.string().optional(),
});
export type ImageAnalysisResult = z.infer<typeof imageAnalysisResultSchema>;

export const suggestedTrimSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  rationale: z.string(),
});

export const videoAnalysisResultSchema = baseFileFields.extend({
  type: z.literal("video"),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  durationSec: z.number().nonnegative(),
  videoCodec: z.string(),
  videoFps: z.number().nonnegative(),
  hasAudio: z.boolean(),
  takenAt: z.string().optional(),
  phash: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  spritePath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  sceneTimes: z.array(z.number().nonnegative()).default([]),
  suggestedTrim: suggestedTrimSchema.optional(),
  ai: videoAnalysisResponseSchema.optional(),
  promptVersion: z.string().optional(),
});
export type VideoAnalysisResult = z.infer<typeof videoAnalysisResultSchema>;

export const transcriptWordSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  word: z.string(),
  probability: z.number().min(0).max(1).optional(),
});

export const transcriptSegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
  words: z.array(transcriptWordSchema).optional(),
});
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptResultSchema = baseFileFields.extend({
  type: z.literal("transcript"),
  language: z.string(),
  text: z.string(),
  segments: z.array(transcriptSegmentSchema),
  srt: z.string().optional(),
  model: z.string(),
  hasWordTimestamps: z.boolean(),
});
export type TranscriptResult = z.infer<typeof transcriptResultSchema>;

const transcriptInlineSchema = transcriptResultSchema
  .pick({
    language: true,
    text: true,
    segments: true,
    srt: true,
    model: true,
    hasWordTimestamps: true,
  })
  .extend({
    updatedAt: z.string().optional(),
  });

export const manifestImageEntrySchema = imageAnalysisResultSchema.extend({
  persons: mediaPersonsSchema.optional(),
  personsStatus: personsStatusSchema.optional(),
});

export const sourceTrimSchema = z.object({
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  originalDurationSec: z.number().positive(),
  trimmedAt: z.string().optional(),
  status: z.enum(["ok", "trim_failed", "skipped"]).optional(),
  // source 枚举：claude = Claude override（--decisions）；algo_fallback = Qwen 失败后 smartTrimWindow；
  // passthrough = 短 clip 不切；first_skip = 第一段不切（hook 段单独处理）；
  // qwen = Qwen trimClipAI 决策（生产默认路径）；qwen_cache = Qwen 缓存命中；
  // fallback = Qwen 失败后算法 fallback（同 algo_fallback，旧名兼容）。
  source: z
    .enum([
      "claude",
      "algo_fallback",
      "passthrough",
      "first_skip",
      "qwen",
      "qwen_cache",
      "fallback",
    ])
    .optional(),
  position: z.enum(["first", "middle", "closing"]).optional(),
  // Qwen reason 在 smart-trim-ai.ts 中被 .slice(0, 500) 截断；max=500 与生产保持一致。
  // Claude decisions reason 存在 trimDecisionEntry.reason（允许 max=2000）。
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  capped: z.boolean().optional(),
  cappedFrom: z.number().positive().optional(),
  fallbackReason: z
    .enum(["timeout", "invalid_json", "schema_error", "range_invalid", "missing_in_decisions"])
    .optional(),
});
export type SourceTrim = z.infer<typeof sourceTrimSchema>;

// ---- trim decisions file ----
// 由 skill 中的 Claude 决策器生成；vlog-smart-trim CLI 读它来切片，不再调 Qwen。
export const trimDecisionEntrySchema = z
  .object({
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    reason: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1).optional(),
    framesCited: z
      .array(
        z.object({
          tSec: z.number().nonnegative(),
          rationale: z.string().max(200),
        }),
      )
      .optional(),
    gapsCited: z
      .array(
        z.object({
          atSec: z.number().nonnegative(),
          gapSec: z.number().positive(),
          rationale: z.string().max(200),
        }),
      )
      .optional(),
    skip: z.boolean().optional(),
  })
  .refine((d) => d.skip === true || d.startSec < d.endSec, {
    message: "startSec must be < endSec (unless skip=true)",
  });
export type TrimDecisionEntry = z.infer<typeof trimDecisionEntrySchema>;

export const trimDecisionsFileSchema = z.object({
  schemaVersion: z.literal("1"),
  generatedAt: z.string(),
  generatedBy: z.string().optional(),
  totalBudgetSec: z.number().positive().optional(),
  // key 为 fid（视频文件名去后缀），如 "dji_mimo_20260516_121336_482_1778925037165_video"
  decisions: z.record(z.string(), trimDecisionEntrySchema),
});
export type TrimDecisionsFile = z.infer<typeof trimDecisionsFileSchema>;

export const manifestVideoEntrySchema = videoAnalysisResultSchema.extend({
  transcript: transcriptInlineSchema.optional(),
  persons: mediaPersonsSchema.optional(),
  personsStatus: personsStatusSchema.optional(),
  sourceTrim: sourceTrimSchema.optional(),
});

export type ManifestImageEntry = z.infer<typeof manifestImageEntrySchema>;
export type ManifestVideoEntry = z.infer<typeof manifestVideoEntrySchema>;

export const batchManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  rootDir: z.string(),
  themeHint: z.string().optional(),
  files: z.array(
    z.discriminatedUnion("type", [manifestImageEntrySchema, manifestVideoEntrySchema]),
  ),
  stats: z.object({
    total: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    videos: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
  }),
});
export type BatchManifest = z.infer<typeof batchManifestSchema>;

export const energyCurveEnum = z.enum(["rising", "cruise", "peak", "wind-down"]);

export const storyboardArcChapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  targetMinutes: z.number().positive(),
  energyCurve: energyCurveEnum,
  rationale: z.string(),
});

export const storyboardArcSchema = z.object({
  hookStrategy: z.string(),
  chapters: z.array(storyboardArcChapterSchema).min(2).max(6),
  endingBeat: z.string(),
});
export type StoryboardArc = z.infer<typeof storyboardArcSchema>;

const kenBurnsTuple = z.preprocess(
  (v) => (v == null ? undefined : v),
  z
    .tuple([
      z.tuple([z.number(), z.number(), z.number()]),
      z.tuple([z.number(), z.number(), z.number()]),
    ])
    .optional(),
);

export const storyboardClipSchema = z.object({
  fileId: z.string(),
  type: z.enum(["photo", "video"]),
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive(),
  kenBurns: kenBurnsTuple.optional(),
  transitionIn: z.enum(["crossfade", "cut", "slide"]).default("crossfade"),
  subtitleStyle: z.enum(["bottom-clean", "kinetic", "off"]).default("bottom-clean"),
  reason: z.string(),
});
export type StoryboardClip = z.infer<typeof storyboardClipSchema>;

export const storyboardChapterSchema = storyboardArcChapterSchema.extend({
  clips: z.array(storyboardClipSchema),
});
export type StoryboardChapter = z.infer<typeof storyboardChapterSchema>;

export const timelineSubtitleSchema = z.object({
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  text: z.string(),
  words: z
    .array(
      z.object({
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().nonnegative(),
        word: z.string(),
      }),
    )
    .optional(),
});

export const timelineClipSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.enum(["photo", "video"]),
  srcStartSec: z.number().nonnegative().optional(),
  srcEndSec: z.number().nonnegative().optional(),
  renderStartFrame: z.number().int().nonnegative(),
  renderDurationFrames: z.number().int().positive(),
  kenBurns: kenBurnsTuple.optional(),
  subtitles: z.array(timelineSubtitleSchema).default([]),
  subtitleStyle: z.enum(["bottom-clean", "kinetic", "off"]).default("bottom-clean"),
  transitionIn: z.enum(["crossfade", "cut", "slide"]).default("crossfade"),
  audioGain: z.number().min(0).max(1).default(0.7),
});
export type TimelineClip = z.infer<typeof timelineClipSchema>;

export const timelineChapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  energyCurve: energyCurveEnum,
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative(),
  titleCard: z.object({
    durationFrames: z.number().int().nonnegative(),
  }),
  clips: z.array(timelineClipSchema),
});
export type TimelineChapter = z.infer<typeof timelineChapterSchema>;

export const selectionGroupSchema = z.object({
  id: z.string(),
  fids: z.array(z.string()).min(2),
  label: z.string().nullable().optional(),
});
export type SelectionGroup = z.infer<typeof selectionGroupSchema>;

export const selectionSchema = z.object({
  version: z.literal(1),
  vlogId: z.string(),
  updatedAt: z.string().optional(),
  excluded: z.array(z.string()).default([]),
  /**
   * 用户期望的视频整体顺序。包含所有视频 fid（排除的也在内 — 排除恢复时保留位置）。
   * 不传或为空数组 → fallback 到 manifest takenAt 顺序。
   */
  order: z.array(z.string()).default([]),
  groups: z.array(selectionGroupSchema).default([]),
  /**
   * task 008: 章节内自定义排序。chapterIdx 为章节下标，customOrder 为该章节内
   * fileIds 的期望排列（成员集合需与章节一致才会被采用）。
   */
  chapterOrders: z
    .array(
      z.object({
        chapterIdx: z.number().int().nonnegative(),
        customOrder: z.array(z.string()),
      }),
    )
    .default([]),
});
export type Selection = z.infer<typeof selectionSchema>;

export const timelineSchema = z.object({
  type: z.literal("vlog"),
  version: z.literal(1),
  meta: z.object({
    theme: z.string(),
    language: z.string().default("zh"),
    targetMinutes: z.number().positive(),
    generatedAt: z.string(),
    modelInfo: z.string().optional(),
  }),
  dimensions: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }),
  totalDurationFrames: z.number().int().positive(),
  chapters: z.array(timelineChapterSchema),
  bgm: z.object({
    source: z.string(),
    gain: z.number().min(0).max(1).default(0.25),
    duckOnSpeech: z.boolean().default(true),
    tracks: z
      .array(
        z.object({
          source: z.string(),
          startFrame: z.number().int().nonnegative(),
          endFrame: z.number().int().nonnegative(),
          gain: z.number().min(0).max(1).optional(),
        }),
      )
      .optional(),
    crossfadeFrames: z.number().int().nonnegative().optional(),
  }),
  outro: z.object({
    durationFrames: z.number().int().positive(),
    text: z.string(),
  }),
});
export type Timeline = z.infer<typeof timelineSchema>;
