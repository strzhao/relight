/**
 * curator-video Worker：每周一北京 09:20 AI 策展人提名候选主题入池。
 *
 * 流程：buildCuratorPrep()（库摘要备料）→ runCuratorDiscovery()（spawn claude -p）
 *   → Zod 校验 → photo id 有效性过滤 → upsert video_theme_pool。
 *
 * 容错契约：策展是旁路——spawn 失败 / 解析失败仅记日志不入池，不影响任何既有
 * 链路（与画廊同步同款容错语义）。confidence=low 不入池（system prompt 已声明）。
 *
 * 幂等语义：UNIQUE(kind,title)——周更重提同一主题 = UPDATE 刷新内容 + 状态复位
 * active（setWhere status<>'done'，已拍成片的提案不被复活）。
 */
import type { Job } from "bullmq";
import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { config } from "../lib/config";
import { buildCuratorPrep } from "../lib/curator/prep";
import { runCuratorDiscovery } from "../lib/curator/runner";

export async function curatorVideoWorker(job: Job): Promise<void> {
  if (!config.curatorVideoEnabled) {
    job.log("[curator] skipped reason=disabled");
    return;
  }
  job.log("[curator] start");

  // 1. 备料
  const prep = await buildCuratorPrep();
  const prepBytes = JSON.stringify(prep).length;
  job.log(
    `[curator] prep bytes=${prepBytes} places=${prep.placeClusters.length} recurring=${prep.recurringDates.length} personLines=${prep.personLines.length}`,
  );

  // 2. spawn claude -p 提名
  const result = await runCuratorDiscovery(prep);
  if (!result.ok) {
    // 旁路容错：失败不影响任何既有链路
    job.log(`[curator] discovery failed err=${result.err}`);
    return;
  }
  const proposals = result.proposals ?? [];
  job.log(`[curator] proposals=${proposals.length}`);

  // 3. 逐条过滤 + 入池
  const now = new Date().toISOString();
  let upserted = 0;
  let skippedLow = 0;
  let invalidIds = 0;
  for (const p of proposals) {
    if (p.confidence === "low") {
      skippedLow++;
      continue;
    }
    // id 有效性过滤：编造/已删除的 id 直接剔除，保留真实子集
    const uniqueIds = [...new Set(p.photo_ids)];
    const found = uniqueIds.length
      ? await db
          .select({ id: schema.photos.id })
          .from(schema.photos)
          .where(inArray(schema.photos.id, uniqueIds))
      : [];
    const validIds = new Set(found.map((r) => r.id));
    invalidIds += uniqueIds.length - validIds.size;
    const finalIds = uniqueIds.filter((id) => validIds.has(id));

    db.insert(schema.videoThemePool)
      .values({
        kind: p.kind,
        title: p.title,
        why: p.why,
        arc: p.arc,
        confidence: p.confidence,
        photoIds: finalIds,
        selectionHint: p.selection_hint,
        status: "active",
        proposedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.videoThemePool.kind, schema.videoThemePool.title],
        set: {
          why: p.why,
          arc: p.arc,
          confidence: p.confidence,
          photoIds: finalIds,
          selectionHint: p.selection_hint,
          status: "active",
          proposedAt: now,
          updatedAt: now,
        },
        // 已拍成片（done）的提案不复活；其余状态（active/rejected/expired）周更复位
        setWhere: sql`${schema.videoThemePool.status} <> 'done'`,
      })
      .run();
    upserted++;
  }

  job.log(`[curator] done upserted=${upserted} skippedLow=${skippedLow} invalidIds=${invalidIds}`);
}
