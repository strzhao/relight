/**
 * COS CORS 一次性配置 CLI（state.md §方案架构 6 / §CLI 契约）
 *
 * 背景：公网画廊站（gallery.stringzhao.life）下载功能需直接 fetch COS 直链，
 * 桶未配 CORS 时 fetch 被拦（<img>/<video> 标签加载不受影响）。
 *
 * 幂等策略：getBucketCors → 已含画廊 origin 的规则则 skip；否则**合并保留已有规则**
 * 后 putBucketCors（putBucketCors 是整表替换，必须先读后合并写回，只追加不删除）。
 *
 * 用法：
 *   pnpm --filter @relight/backend cos:cors            # 默认 dry-run：只打印将写入的规则，不触网
 *   pnpm --filter @relight/backend cos:cors -- --yes   # 真实执行（get → merge → put）
 *
 * 退出码（§CLI 契约）：
 *   0 = 成功（含幂等 skip）
 *   1 = COS 凭据缺失（config.cos 默认值未覆盖）
 *   2 = COS API 调用失败
 */
import { config } from "../lib/config";

/** 画廊站 origin（下载 fetch 的发起源） */
export const GALLERY_ORIGIN = "https://gallery.stringzhao.life";

/** 将写入的 CORS 规则（§CLI 契约 写入规则 payload） */
export const INCOMING_CORS_RULE = {
  AllowedOrigin: [GALLERY_ORIGIN],
  AllowedMethod: ["GET", "HEAD"],
  AllowedHeader: ["*"],
  MaxAgeSeconds: 600,
};

/** CORS 规则（cos-nodejs-sdk-v5 CORSRule 的结构化子集，getBucketCors 返回项做宽松兼容） */
export interface CorsRule {
  AllowedOrigin?: string[];
  /** getBucketCors 回读为复数键（sdk base.js 单复数互转），判存/去重双键兼容 */
  AllowedOrigins?: string[];
  AllowedMethod?: string[];
  AllowedMethods?: string[];
  AllowedHeader?: string[];
  AllowedHeaders?: string[];
  ExposeHeader?: string[];
  ExposeHeaders?: string[];
  /** 回读形态为字符串（putBucketCors 接受 number|string） */
  MaxAgeSeconds?: number | string;
  [key: string]: unknown;
}

/**
 * 纯函数：按 origin 存在性合并规则表（单/复数键双兼容）。
 *
 * - 已有任一规则 origins 含画廊 origin → 幂等跳过（changed=false，原表原样返回）；
 *   但若表内存在重复规则（同 origins+methods 签名）→ 去重后写回自愈（修复历史重复写入）
 * - 否则新规则追加在表尾（保留他人已有配置，只追加不删除）
 */
export function mergeCorsRules(
  existing: CorsRule[] | null | undefined,
  incoming: CorsRule,
): { rules: CorsRule[]; changed: boolean; action: "skip" | "append" | "dedupe" } {
  const rules: CorsRule[] = Array.isArray(existing) ? existing : [];
  const originsOf = (r: CorsRule): string[] => {
    const o = r.AllowedOrigins ?? r.AllowedOrigin;
    return Array.isArray(o) ? o : [];
  };
  const methodsOf = (r: CorsRule): string[] => {
    const m = r.AllowedMethods ?? r.AllowedMethod;
    return Array.isArray(m) ? m : [];
  };
  // 去重签名：origins + methods 排序序列化（字段级差异如同 origins 不同 MaxAge 不合并）
  const dedupeKey = (r: CorsRule): string =>
    JSON.stringify({ origins: originsOf(r).slice().sort(), methods: methodsOf(r).slice().sort() });
  const seen = new Set<string>();
  const deduped = rules.filter((r) => {
    const key = dedupeKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hasGallery = deduped.some((r) => originsOf(r).includes(GALLERY_ORIGIN));
  if (hasGallery) {
    return deduped.length === rules.length
      ? { rules, changed: false, action: "skip" }
      : { rules: deduped, changed: true, action: "dedupe" };
  }
  return { rules: [...deduped, incoming], changed: true, action: "append" };
}

// ===== COS client（动态 import，凭据校验后再实例化） =====

type CorsClient = {
  getBucketCors: (params: { Bucket: string; Region: string }) => Promise<{
    CORSRules?: unknown;
    statusCode?: number;
  }>;
  putBucketCors: (params: {
    Bucket: string;
    Region: string;
    CORSRules: CorsRule[];
  }) => Promise<{ statusCode?: number }>;
};

async function getCosClient(): Promise<CorsClient> {
  const mod = (await import("cos-nodejs-sdk-v5")) as unknown as {
    default: new (opts: { SecretId: string; SecretKey: string }) => CorsClient;
  };
  return new mod.default({
    SecretId: config.cos.secretId,
    SecretKey: config.cos.secretKey,
  });
}

/** getBucketCors：桶从未配置 CORS 时 COS 返回 NoSuchCORSConfiguration（404）→ 视为空表 */
async function getExistingRules(client: CorsClient): Promise<CorsRule[]> {
  try {
    const res = await client.getBucketCors({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
    });
    return Array.isArray(res.CORSRules) ? (res.CORSRules as CorsRule[]) : [];
  } catch (err) {
    const e = err as { code?: string; statusCode?: number; message?: string };
    const noConfig =
      e?.code === "NoSuchCORSConfiguration" ||
      e?.statusCode === 404 ||
      (typeof e?.message === "string" && e.message.includes("NoSuchCORSConfiguration"));
    if (noConfig) return [];
    throw err;
  }
}

const HELP = `
COS CORS 一次性配置 CLI — 为画廊站下载功能开放跨域 GET/HEAD

用法:
  pnpm --filter @relight/backend cos:cors -- [options]

参数:
  (无参数)     默认 dry-run：打印将写入的 CORS 规则 JSON，不触网
  --yes        真实执行（getBucketCors → 合并 → putBucketCors，幂等）
  --help       显示本帮助

退出码:
  0 = 成功（含幂等 skip）
  1 = COS 凭据缺失
  2 = COS API 调用失败
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  const yes = argv.includes("--yes");
  // 无参默认 dry-run（§CLI 契约：--yes 才执行）
  const dryRun = !yes;

  console.log("=".repeat(72));
  console.log("  COS CORS 配置 (setup-cos-cors)");
  console.log("=".repeat(72));
  console.log(`  Bucket: ${config.cos.bucket} / Region: ${config.cos.region}`);
  console.log(`  Origin: ${GALLERY_ORIGIN}`);

  // 凭据缺失 → exit 1（dry-run 也校验：QA 场景 C4 清空 env 后无参执行须 exit 1）
  if (!config.cos.secretId || !config.cos.secretKey) {
    console.error(
      "\n[exit 1] COS 凭据缺失（TENCENTCLOUD_SECRET_ID/SECRET_KEY 或 COS_SECRET_ID/SECRET_KEY 均未设置）",
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n[dry-run] 将写入的 CORS 规则（--yes 执行时合并保留已有规则后整表写回）:");
    console.log(JSON.stringify([INCOMING_CORS_RULE], null, 2));
    console.log("\n[dry-run] 未触网。加 --yes 真实执行。");
    process.exit(0);
  }

  // ---- 真实执行：get → merge → put ----
  let client: CorsClient;
  try {
    client = await getCosClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[exit 2] COS SDK 初始化失败: ${msg}`);
    process.exit(2);
  }

  let existing: CorsRule[];
  try {
    existing = await getExistingRules(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[exit 2] getBucketCors 失败: ${msg}`);
    process.exit(2);
  }

  const { rules, changed, action } = mergeCorsRules(existing, INCOMING_CORS_RULE);
  console.log(`  已有规则: ${existing.length} 条`);

  if (!changed) {
    console.log(`[skip] origin exists: ${GALLERY_ORIGIN}（幂等，无需写入）`);
    process.exit(0);
  }

  try {
    await client.putBucketCors({
      Bucket: config.cos.bucket,
      Region: config.cos.region,
      CORSRules: rules,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[exit 2] putBucketCors 失败: ${msg}`);
    process.exit(2);
  }

  if (action === "dedupe") {
    console.log(
      `[ok] origin exists: ${GALLERY_ORIGIN}（检测到重复规则，去重写回 ${existing.length} → ${rules.length} 条）`,
    );
  } else {
    console.log(`[ok] rule added: ${GALLERY_ORIGIN}（规则表 ${rules.length} 条）`);
  }
  console.log(
    '\n验证: curl -sI -H "Origin: https://gallery.stringzhao.life" <cos-url> | grep -i access-control-allow-origin',
  );
  process.exit(0);
}

export default main;

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("setup-cos-cors.ts") || process.argv[1].endsWith("setup-cos-cors.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("[setup-cos-cors] 严重错误:", err);
    process.exit(2);
  });
}
