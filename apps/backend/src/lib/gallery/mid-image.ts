/**
 * COS 中尺寸图生成（state.md §契约规约 计算契约 mid 图生成）
 *
 * `generateMidBuffer(filePath): Promise<Buffer | null>`
 *
 * 降级顺序（image-processing.md 沉淀 bug 模式）：
 *   1. HEIC：`isHeicFile(filePath)` 前置检测 → `heicFileToJpeg(filePath, {maxWidth,maxHeight,quality})`
 *      （禁先 sharp——HEIC 须检测前置；sharp 预编译 libvips 无 HEIC 解码支持）
 *   2. RAW/DNG：`extractRawPreview(filePath)` 拿嵌入 JPEG → sharp resize
 *   3. 普通：`sharp(filePath).resize(1600,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85})`
 *
 * 容错契约（旁路）：任何解码/读文件失败 → console.warn + 返回 null，**不 throw**
 * （原图本地缺失/HEIC 解码失败/NAS 漂移/dcraw 缺失 → 跳过 mid 上传，original fallback thumb）
 *
 * DbC 不变量：
 *   - 输出 JPEG 宽 <= 1600 且高 <= 1600
 *   - 输出体积 <= 800KB（quality 85 + 1600px 经验上界）
 *   - 输入文件不存在 → null（不 throw）
 */
import path from "node:path";
import sharp from "sharp";
import { heicFileToJpeg, isHeicFile } from "../heic";
import { RAW_EXTENSIONS, extractRawPreview } from "../raw";

/** mid 图最大边长（px） */
const MID_MAX = 1600;
/** mid 图 JPEG quality */
const MID_QUALITY = 85;

/**
 * 生成中尺寸 JPEG Buffer（<=1600px，quality 85）。
 *
 * @param filePath 本地绝对路径（photos.filePath；scan 入库时已是 path.join(rootPath, ...) 绝对路径）
 * @returns JPEG Buffer，或 null（任何降级失败）
 */
export async function generateMidBuffer(filePath: string): Promise<Buffer | null> {
  const ext = path.extname(filePath).toLowerCase();

  try {
    // 1. HEIC 前置检测（禁先 sharp——libvips 无 HEIC 解码）
    if (isHeicFile(filePath)) {
      try {
        return await heicFileToJpeg(filePath, {
          maxWidth: MID_MAX,
          maxHeight: MID_MAX,
          quality: MID_QUALITY,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[gallery/mid-image] HEIC 转码失败 (${filePath}): ${msg}`);
        return null;
      }
    }

    // 2. RAW/DNG → dcraw 提取嵌入 JPEG → sharp resize
    if (RAW_EXTENSIONS.has(ext)) {
      try {
        const rawPreview = await extractRawPreview(filePath);
        return await sharp(rawPreview)
          .resize(MID_MAX, MID_MAX, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: MID_QUALITY })
          .toBuffer();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[gallery/mid-image] RAW 预览提取/转码失败 (${filePath}): ${msg}`);
        return null;
      }
    }

    // 3. 普通：sharp 直接 resize（withoutEnlargement 保证小图不放大量图）
    try {
      return await sharp(filePath)
        .resize(MID_MAX, MID_MAX, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: MID_QUALITY })
        .toBuffer();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gallery/mid-image] sharp 解码失败 (${filePath}): ${msg}`);
      return null;
    }
  } catch (err) {
    // 兜底：任何未预期错误（如文件不存在的 readFile 抛错在 heic 分支已被内层 catch，
    // 但 sharp 构造函数对不存在文件可能在 resize 阶段才抛）→ null
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gallery/mid-image] generateMidBuffer 未预期失败 (${filePath}): ${msg}`);
    return null;
  }
}
