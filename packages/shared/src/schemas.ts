import { z } from "zod";

/** 创建存储源 */
export const createStorageSourceSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["local", "smb", "webdav"]),
  rootPath: z.string().min(1),
});

/** 更新设置 */
export const updateSettingsSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

/** 触发扫描 */
export const scanNowSchema = z.object({
  storageSourceId: z.string().uuid().optional(),
  skipAnalysis: z.boolean().optional().default(false),
  forceRegenerate: z.boolean().optional().default(false),
});

/** 触发批量分析 */
export const analyzeFilesSchema = z.object({
  photoIds: z.array(z.string().uuid()).min(1).max(100),
  force: z.boolean().optional(),
});

/** 每日精选查询 */
export const dailyPickQuerySchema = z.object({
  date: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 照片查询 */
export const photoQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  tagId: z.string().uuid().optional(),
  storageSourceId: z.string().uuid().optional(),
  sortBy: z.enum(["createdAt", "takenAt", "fileSize"]).default("takenAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** 批量触发分析 */
export const analyzePhotosSchema = z.object({
  photoIds: z.array(z.string().uuid()).min(1).max(50),
  force: z.boolean().optional(),
});

/** 管理后台批量分析（按筛选条件） */
export const analyzeBatchSchema = z.object({
  storageSourceId: z.string().uuid().optional(),
  minScore: z.number().min(0).max(10).optional(),
  force: z.boolean().optional().default(false),
});

/** 设置连拍代表照片 */
export const setRepresentativeSchema = z.object({
  photoId: z.string().min(1),
});

/** 更新人物（name/nickname/bio/hidden）— null 或 "" 视为清空 */
export const updatePersonSchema = z.object({
  name: z.string().max(20).nullable().optional(),
  nickname: z.string().max(20).nullable().optional(),
  bio: z.string().max(200).nullable().optional(),
  hidden: z.boolean().optional(),
});

/** 设置人物代表头像（指定 faceId） */
export const setPersonRepresentativeSchema = z.object({
  faceId: z.string().min(1),
});

/** 合并人物（搬迁所有 faces 到目标人物） */
export const mergePersonSchema = z.object({
  targetPersonId: z.string().min(1),
});

export type CreateStorageSource = z.infer<typeof createStorageSourceSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type ScanNow = z.infer<typeof scanNowSchema>;
export type AnalyzeFiles = z.infer<typeof analyzeFilesSchema>;
export type DailyPickQuery = z.infer<typeof dailyPickQuerySchema>;
export type PhotoQuery = z.infer<typeof photoQuerySchema>;
export type AnalyzePhotos = z.infer<typeof analyzePhotosSchema>;
export type AnalyzeBatch = z.infer<typeof analyzeBatchSchema>;
export type SetRepresentative = z.infer<typeof setRepresentativeSchema>;
export type UpdatePerson = z.infer<typeof updatePersonSchema>;
export type SetPersonRepresentative = z.infer<typeof setPersonRepresentativeSchema>;
export type MergePerson = z.infer<typeof mergePersonSchema>;
