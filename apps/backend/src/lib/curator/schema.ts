/**
 * 策展人输出契约（Zod）——claude -p 返回的 JSON 数组校验。
 * 字段与 prompts/v2/curator/discover/system.txt 的输出 schema 一一对应。
 */
import { z } from "zod";

export const curatorProposalSchema = z.object({
  /** 提案类型（开放枚举，运行时不限制取值） */
  kind: z.string().min(1),
  title: z.string().min(1),
  why: z.string().optional(),
  arc: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  photo_ids: z.array(z.string()).default([]),
  selection_hint: z.string().optional(),
});

export const curatorOutputSchema = z.array(curatorProposalSchema);

export type CuratorProposal = z.infer<typeof curatorProposalSchema>;
