import { z } from "zod";
import { photoAnalysisResponseSchema } from "../../ai/response-parser";

export { photoAnalysisResponseSchema };
export type PhotoAnalysisResponse = z.infer<typeof photoAnalysisResponseSchema>;

export const videoAnalysisExtraSchema = z.object({
  videoNarrative: z.string().optional(),
  videoPacing: z.enum(["slow", "medium", "fast"]).optional(),
  motionScore: z.number().min(0).max(100).optional(),
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

export const manifestImageEntrySchema = imageAnalysisResultSchema;

export const manifestVideoEntrySchema = videoAnalysisResultSchema.extend({
  transcript: transcriptInlineSchema.optional(),
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
