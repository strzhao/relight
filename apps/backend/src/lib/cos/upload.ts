/**
 * COS 上传基础（state.md §组件设计 1 / §契约规约）
 *
 * 封装 cos-nodejs-sdk-v5，提供：
 *   - uploadFile(localPath, cosKey): 从磁盘路径上传（壁纸 jpg / 缩略图 jpg / 视频 mp4 / 封面 jpg）
 *   - uploadBuffer(buf, cosKey, contentType): 从 Buffer 上传（未来 inline 生成资源用）
 *   - cosPublicUrl(cosKey): 纯函数拼公网 URL（不查 COS，单测用）
 *
 * 契约（§契约规约 COS 公网 URL）：
 *   `https://${bucket}.cos.${region}.myqcloud.com/${cosKey}`
 *   默认：`https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/...`
 *
 * 幂等：同 cosKey 上传覆盖（COS putObject 天然覆盖，不报错）
 * 重试：失败重试 3 次（指数退避 200ms / 400ms / 800ms）
 * 容错：本模块是底层 lib，抛错给调用方；调用方（daily-selection/daily-video）负责 try/catch 旁路
 */
import { readFile } from "node:fs/promises";
import { config } from "../config";

// 动态 import cos-nodejs-sdk-v5，避免本机未配置凭据时顶层实例化抛错。
// 测试通过 vi.mock("cos-nodejs-sdk-v5") 注入 mock。
let cosClient: {
  putObject: (params: {
    Bucket: string;
    Region: string;
    Key: string;
    Body: Buffer | string;
    ContentType?: string;
  }) => Promise<{ statusCode?: number }>;
} | null = null;

async function getCosClient() {
  if (cosClient) return cosClient;
  // 凭据缺失时直接抛（调用方旁路）——本机开发无 COS 时画廊同步静默 skip
  if (!config.cos.secretId || !config.cos.secretKey) {
    throw new Error(
      "[cos] COS 凭据缺失（TENCENTCLOUD_SECRET_ID/SECRET_KEY 或 COS_SECRET_ID/SECRET_KEY 均未设置），跳过 COS 上传",
    );
  }
  const mod = (await import("cos-nodejs-sdk-v5")) as {
    default: new (opts: {
      SecretId: string;
      SecretKey: string;
    }) => {
      putObject: (params: {
        Bucket: string;
        Region: string;
        Key: string;
        Body: Buffer | string;
        ContentType?: string;
      }) => Promise<{ statusCode?: number }>;
    };
  };
  cosClient = new mod.default({
    SecretId: config.cos.secretId,
    SecretKey: config.cos.secretKey,
  });
  return cosClient;
}

/** 测试注入 mock client（仅 __tests__ 用，prod 不调） */
export function __setCosClientForTest(client: typeof cosClient): void {
  cosClient = client;
}

/**
 * 拼接 COS 公网 URL（纯函数，不查 COS）。
 *
 * `https://${bucket}.cos.${region}.myqcloud.com/${cosKey}`
 *
 * cosKey 应已含 prefix（如 `relight/wallpapers/...`）；本函数不加 prefix，
 * 由 key 常量函数（wallpaperCosKey/photoCosKey 等）负责拼完整 key。
 */
export function cosPublicUrl(cosKey: string): string {
  return `https://${config.cos.bucket}.cos.${config.cos.region}.myqcloud.com/${cosKey}`;
}

/** 指数退避 sleep（ms） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次 putObject 调用（含参数构造） */
async function putOnce(cosKey: string, body: Buffer, contentType: string): Promise<string> {
  const client = await getCosClient();
  const res = await client.putObject({
    Bucket: config.cos.bucket,
    Region: config.cos.region,
    Key: cosKey,
    Body: body,
    ContentType: contentType,
  });
  // COS 成功 statusCode 通常 200；失败时 sdk 会 throw，这里是防御性检查
  if (res?.statusCode && res.statusCode >= 400) {
    throw new Error(`[cos] putObject 失败 statusCode=${res.statusCode} key=${cosKey}`);
  }
  return cosPublicUrl(cosKey);
}

/** 最大重试次数（首次 + 重试共 MAX_RETRIES+1 次） */
const MAX_RETRIES = 3;

/**
 * 带重试的 putObject：失败按指数退避（200/400/800ms）重试至 MAX_RETRIES 次。
 *
 * 容错契约（§契约规约 容错契约）：重试耗尽后 **不 throw**，console.warn 记录错误并返回空串。
 * 画廊是旁路（不阻塞精选/视频主流程）；调用方（sync.ts）仍保留 try/catch 作双保险。
 * 凭据缺失类错误也不 throw（本机开发无 COS 时静默跳过）。
 *
 * @returns 成功时公网 URL；失败时空串（调用方可按需判断）
 */
async function putWithRetry(cosKey: string, body: Buffer, contentType: string): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await putOnce(cosKey, body, contentType);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // 凭据缺失不重试（重试无意义）
      if (msg.includes("COS 凭据缺失")) {
        console.warn(`[cos] ${msg}（跳过上传 key=${cosKey}）`);
        return "";
      }
      if (attempt < MAX_RETRIES) {
        const backoff = 200 * 2 ** attempt; // 200 / 400 / 800
        await sleep(backoff);
      }
    }
  }
  // 重试耗尽：容错契约——不 throw，console.warn 记录（运维可见），返回空串
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.warn(
    `[cos] putObject 重试 ${MAX_RETRIES} 次仍失败 key=${cosKey}（画廊旁路，不阻塞主流程）: ${msg}`,
  );
  return "";
}

/**
 * 从 Buffer 上传到 COS。
 *
 * @param buf 文件内容
 * @param cosKey 完整 COS key（含 prefix）
 * @param contentType MIME 类型
 * @returns 公网 URL
 */
export async function uploadBuffer(
  buf: Buffer,
  cosKey: string,
  contentType: string,
): Promise<string> {
  return putWithRetry(cosKey, buf, contentType);
}

/**
 * 从磁盘路径上传到 COS（读文件 → Buffer → uploadBuffer）。
 *
 * @param localPath 本地绝对路径（如 composedImagePath / thumbnailPath / outputPath）
 * @param cosKey 完整 COS key（含 prefix）
 * @param contentType MIME（默认 image/jpeg；视频传 video/mp4）
 * @returns 公网 URL
 */
export async function uploadFile(
  localPath: string,
  cosKey: string,
  contentType = "image/jpeg",
): Promise<string> {
  const buf = await readFile(localPath);
  return putWithRetry(cosKey, buf, contentType);
}
