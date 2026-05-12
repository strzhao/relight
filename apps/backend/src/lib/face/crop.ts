/**
 * cropFaceToJpeg：从原图 buffer 裁剪人脸区域，输出用于属性分析的 JPEG buffer。
 *
 * 参考 aligner.ts 的 expandBBox 逻辑，但输出 JPEG（而非 Float32Array），
 * 外扩 1.5×，最长边压到 224px，quality 85。
 */
import sharp from "sharp";
import { expandBBox } from "./aligner";

/**
 * 从原图裁剪人脸区域并输出 JPEG buffer。
 *
 * @param imageBuffer 原图 buffer（已应用 EXIF rotate）
 * @param bbox 人脸 bbox（整数像素坐标，相对于 imageBuffer 像素方向）
 * @param imageWidth 图片实际宽度（rotate 后）
 * @param imageHeight 图片实际高度（rotate 后）
 * @returns JPEG buffer，最长边 224px，外扩 1.5×，quality 85
 */
export async function cropFaceToJpeg(
  imageBuffer: Buffer,
  bbox: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): Promise<Buffer> {
  const region = expandBBox(bbox, imageWidth, imageHeight, 1.5);

  const maxSide = 224;
  const scale = Math.min(maxSide / region.w, maxSide / region.h, 1);
  const outW = Math.max(1, Math.round(region.w * scale));
  const outH = Math.max(1, Math.round(region.h * scale));

  return sharp(imageBuffer, { failOn: "none" })
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .resize(outW, outH, { fit: "fill", withoutEnlargement: false })
    .jpeg({ quality: 85 })
    .toBuffer();
}
