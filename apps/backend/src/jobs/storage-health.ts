import type { StorageSourceStatus } from "@relight/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { getSettingValue, setSettingValue } from "../lib/settings";
import { checkPathAccessibility } from "../storage/check-path";

/**
 * 存储源可达性主动探测。
 *
 * 触发点：每日 0:00 的 daily-selection-cron 在精选前调用一次（见 jobs/daily-selection.ts）。
 * 复用 storage/check-path.ts 的 checkPathAccessibility（已能识别软链断链→unmounted）。
 *
 * worker 侧只写库 + 记翻转日志，不弹通知——worker 进程弹不了 mac 通知。
 * mac 端通过 5s 轮询 /api/runtime/status 读 services.storage，发现状态翻转后弹通知。
 */

const UNHEALTHY: ReadonlySet<StorageSourceStatus> = new Set([
  "inaccessible",
  "unmounted",
  "permission_denied",
]);

/** settings key：记录某存储源上次探测状态（去抖翻转判定，跨重启持久） */
function lastStatusKey(sourceId: string): string {
  return `storage.health.${sourceId}.lastStatus`;
}

export interface ProbeAllSourcesResult {
  overall: "healthy" | "unhealthy";
  /** 本次探测中状态发生有效翻转的源数（供日志/测试断言） */
  flippedCount: number;
  /** 探测明细（供 runtime/status 之外的场景消费） */
  sources: Array<{
    id: string;
    name: string;
    status: StorageSourceStatus;
    lastError: string | null;
  }>;
}

/**
 * 探测所有 enabled 存储源的可达性，写回 status/lastError，记录翻转。
 *
 * 翻转去抖规则（避免反复打扰）：
 * - 状态未变化 → 不计（连续 unhealthy 不重复告警）
 * - null → healthy（首启正常）→ 不计（避免首启全员"恢复"轰炸）
 * - 涉及 unknown → 不计（首启/未探测噪音）
 * - 其余变化（含 null→unmounted 首启漂移、healthy↔unhealthy）→ 计为翻转
 */
export async function probeAllSources(log: (msg: string) => void): Promise<ProbeAllSourcesResult> {
  const sources = await db
    .select({
      id: schema.storageSources.id,
      name: schema.storageSources.name,
      rootPath: schema.storageSources.rootPath,
    })
    .from(schema.storageSources)
    .where(eq(schema.storageSources.enabled, true));

  if (sources.length === 0) {
    return { overall: "healthy", flippedCount: 0, sources: [] };
  }

  let unhealthyCount = 0;
  let flippedCount = 0;
  const detail: ProbeAllSourcesResult["sources"] = [];

  // 并发探测，每源自带 3s 超时（checkPathAccessibility 内部 withTimeout）
  await Promise.all(
    sources.map(async (source) => {
      const result = await checkPathAccessibility(source.rootPath);
      const newStatus = result.status;

      // 写回 status/lastError（写法参照 jobs/scan-storage.ts 的预检分支）
      await db
        .update(schema.storageSources)
        .set({ status: newStatus, lastError: result.lastError })
        .where(eq(schema.storageSources.id, source.id));

      detail.push({
        id: source.id,
        name: source.name,
        status: newStatus,
        lastError: result.lastError,
      });

      if (UNHEALTHY.has(newStatus)) unhealthyCount++;

      // 去抖翻转判定
      const key = lastStatusKey(source.id);
      const lastStatus = (await getSettingValue(key)) as StorageSourceStatus | null;

      if (newStatus !== lastStatus) {
        await setSettingValue(key, newStatus);

        const isInitialHealthy = lastStatus === null && newStatus === "healthy";
        const involvesUnknown = lastStatus === "unknown" || newStatus === "unknown";
        if (!isInitialHealthy && !involvesUnknown) {
          flippedCount++;
          log(
            `[storage] ${source.name} 状态翻转：${lastStatus ?? "（未记录）"} → ${newStatus}${result.lastError ? `（${result.lastError}）` : ""}`,
          );
        }
      }
    }),
  );

  return {
    overall: unhealthyCount > 0 ? "unhealthy" : "healthy",
    flippedCount,
    sources: detail,
  };
}
