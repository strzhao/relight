/**
 * 运动描述（motionPrompt）生成 — hero-only 两步链路（2026-09-25 拆分，契约 C6/C7）
 *
 *   facts（本地 qwen vision）→ 中立画面事实记录（严禁运动/动作词，prompt 侧约束）
 *   motion（外部 deepseek 纯文本）→ 30-50 字微动视频运动描述 + Audio 环境音指引
 *
 * 两步法而非 deepseek 直连看图的理由（设计实测）：① 生成质量更优（弱化词 1.1 vs 2.0，
 * 零状态改变天数 3/7 vs 4/6）；② 家庭照片像素不出机器——只有一段中立文字发给外部 API，
 * facts 这一跳跑本地 qwen 零外部成本。
 *
 * 容错契约（C6）：任一步失败 → 返回 null（调用方不写库，motion_prompt 保持 null，
 * 由 wallpaper-video 既有分层解析链 `motionPrompt || faceBbox ? Person : Scene` 兜底），
 * 且 console.warn 落 stdout（不能只 job.log——那是 BullMQ→Redis，PM2 日志里看不到）。
 *
 * 本模块同时是验收谓词 3.P6 的驱动接缝（lib 级可导出函数）：对任意照片路径调
 * `generateHeroMotionPrompt({photoId, filePath, sourceType: "local", ...})` 即可单独
 * 生成一次运动描述（不涉视频生成）。
 */
import path from "node:path";
import sharp from "sharp";
import { aiClient } from "../../ai/client";
import { loadPrompts } from "../../ai/prompts";
import { parseMotionFactsResponse, parseMotionResponse } from "../../ai/response-parser";
import { type IStorageAdapter, createStorageAdapter } from "../../storage";
import { config } from "../config";
import { RAW_EXTENSIONS, extractRawPreview } from "../raw";

/** hero 候选的最小输入形状（ClusteredCandidate 的文件定位子集，便于单测/CLI 构造） */
export interface HeroMotionInput {
  photoId: string;
  mediaType?: string | null;
  filePath: string;
  /** 视频候选的 cover 缩略图（mediaType=video 时必读） */
  thumbnailPath?: string | null;
  /** 存储源类型（createStorageAdapter 工厂入参） */
  sourceType: string;
}

/** motion 第二步的生成参数上限（30-50 字中文 + Audio 短语，1024 tokens 余量充足） */
const MOTION_MAX_TOKENS = 1024;

/**
 * hero 图 → 2048px 内 JPEG base64（vision 输入），复用原 narrate 的三分支逻辑：
 * 视频 cover 缩略图 / DNG 提取内嵌 JPEG 预览（dcraw）/ 普通图（HEIC 先经 heic-decode 解码）。
 *
 * 从 jobs/daily-selection.ts 抽出（2026-09-25）：narrate（全 12 entry）与 hero motion
 * 阶段共用，避免三分支逻辑双写漂移。
 *
 * @param log 日志函数（DNG 分支有进度提示）
 * @returns JPEG base64（mimeType 恒 image/jpeg）
 */
export async function prepareHeroJpeg(
  candidate: Pick<HeroMotionInput, "mediaType" | "filePath" | "thumbnailPath">,
  adapter: IStorageAdapter,
  log: (msg: string) => void = () => {},
): Promise<string> {
  const isVideo = (candidate.mediaType ?? "image") === "video";
  let buffer: Buffer;

  if (isVideo) {
    if (!candidate.thumbnailPath) {
      throw new Error("视频无 cover 缩略图");
    }
    const fs = await import("node:fs/promises");
    const coverBuffer = await fs.readFile(candidate.thumbnailPath);
    buffer = await sharp(coverBuffer)
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else {
    const ext = path.extname(candidate.filePath).toLowerCase();
    if (RAW_EXTENSIONS.has(ext)) {
      log("DNG 文件，提取 JPEG 预览");
      buffer = await extractRawPreview(candidate.filePath);
      buffer = await sharp(buffer)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else {
      buffer = await adapter.getFileBuffer(candidate.filePath);
      const { isHeicBuffer, convertHeicToJpeg } = await import("../heic");
      if (isHeicBuffer(buffer)) {
        buffer = await convertHeicToJpeg(buffer, {
          maxWidth: 2048,
          maxHeight: 2048,
          quality: 85,
        });
      } else {
        buffer = await sharp(buffer)
          .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      }
    }
  }

  return buffer.toString("base64");
}

/**
 * hero 运动描述生成（facts → motion 两步）。
 *
 * 永不 throw：任何失败（凭据缺失 / AI 调用抛错 / 解析失败 / 长度越界）→ console.warn
 * 落 stdout 并返回 null（C6：失败不写库，由 wallpaper-video 分层默认 prompt 兜底）。
 *
 * @returns 运动描述纯文本；失败返回 null
 */
export async function generateHeroMotionPrompt(
  input: HeroMotionInput,
  opts: { log?: (m: string) => void } = {},
): Promise<string | null> {
  const log = opts.log ?? (() => {});
  const tag = `[motion] photoId=${input.photoId}`;
  try {
    // 凭据预检：未配置外部模型 key 时直接旁路（不打无谓的网络调用；6.P3 仍留 warn 行）
    if (!config.ai.motionApiKey) {
      console.warn(
        `${tag} 运动描述生成跳过：AI_MOTION_API_KEY 未配置（motion_prompt 保持 null，壁纸视频走分层默认 prompt）`,
      );
      return null;
    }

    // ---- 第一步：中立画面事实记录（本地 qwen vision，零外部成本）----
    const adapter = createStorageAdapter(input.sourceType);
    const base64 = await prepareHeroJpeg(input, adapter, log);
    const factsPrompts = await loadPrompts("v2", "daily/motion-facts");
    const factsRaw = await aiClient.analyzePhoto(
      base64,
      "image/jpeg",
      factsPrompts.system,
      factsPrompts.user,
    );
    const {
      parsed: factsParsed,
      error: factsError,
      fallback: factsFallback,
    } = parseMotionFactsResponse(factsRaw);
    const record = factsParsed?.record ?? factsFallback?.record ?? null;
    if (!record) {
      console.warn(
        `${tag} 运动描述生成失败（facts 步解析不出画面事实记录，不写库回退默认 prompt）: ${factsError ?? "未知"}`,
      );
      return null;
    }
    log(`${tag} facts 完成（${record.length} 字）`);

    // ---- 第二步：运动描述（外部 deepseek 纯文本）----
    const motionPrompts = await loadPrompts("v2", "daily/motion");
    const motionUser = motionPrompts.user.replace("{facts}", record);
    const motionRaw = await aiClient.chatWithModel(motionUser, motionPrompts.system, {
      model: config.ai.motionModel,
      baseUrl: config.ai.motionBaseUrl,
      apiKey: config.ai.motionApiKey,
      maxTokens: MOTION_MAX_TOKENS,
    });
    const { prompt, error } = parseMotionResponse(motionRaw);
    if (!prompt) {
      console.warn(
        `${tag} 运动描述生成失败（motion 步输出不可用，不写库回退默认 prompt）: ${error ?? "未知"}`,
      );
      return null;
    }
    return prompt;
  } catch (err) {
    console.warn(
      `${tag} 运动描述生成失败（不写库回退默认 prompt）: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
