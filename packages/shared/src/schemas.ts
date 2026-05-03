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
  sortBy: z.enum(["createdAt", "takenAt", "fileSize"]).default("createdAt"),
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

export type CreateStorageSource = z.infer<typeof createStorageSourceSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type ScanNow = z.infer<typeof scanNowSchema>;
export type DailyPickQuery = z.infer<typeof dailyPickQuerySchema>;
export type PhotoQuery = z.infer<typeof photoQuerySchema>;
