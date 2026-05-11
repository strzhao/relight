/**
 * 简化人脸对齐：bbox 外扩 1.3× → sharp extract → resize 112×112 → 转 RGB Float32Array。
 *
 * 跳过 5-landmark similarity transform（精度损失 ~2-3%）以避免引入 @napi-rs/canvas 依赖。
 * 1000 张相册可接受这个折损。
 *
 * 输入：原图 buffer + bbox（pixel 坐标），输出：normalize 到 [-1,1] 的 RGB CHW Float32Array(3*112*112)。
 *
 * patterns.md 提示：sharp 处理网络/SMB 挂载文件先 readFile 读入 Buffer 再传 sharp。
 * 调用方应已经把文件读为 buffer 后调用此函数。
 */
import sharp from "sharp";

export interface BBox {
  /** 左上角 x（像素） */
  x: number;
  /** 左上角 y（像素） */
  y: number;
  /** 宽度（像素） */
  w: number;
  /** 高度（像素） */
  h: number;
}

export interface AlignerOptions {
  /** 外扩倍数，默认 1.3 */
  expand?: number;
  /** 输出尺寸，默认 112 */
  size?: number;
}

/** 把 bbox 按 expand 倍率外扩，再 clamp 到图片范围内 */
export function expandBBox(
  bbox: BBox,
  imageWidth: number,
  imageHeight: number,
  expand = 1.3,
): BBox {
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const newW = bbox.w * expand;
  const newH = bbox.h * expand;
  let x = Math.round(cx - newW / 2);
  let y = Math.round(cy - newH / 2);
  let w = Math.round(newW);
  let h = Math.round(newH);

  // clamp 到图片边界
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > imageWidth) w = imageWidth - x;
  if (y + h > imageHeight) h = imageHeight - y;

  // 极端情况：bbox 完全在图外（不该发生），保留至少 1×1
  if (w < 1) w = 1;
  if (h < 1) h = 1;

  return { x, y, w, h };
}

/**
 * 从原图 buffer crop + resize 到 size×size，返回 ArcFace 输入张量数据。
 *
 * - 输出 NCHW Float32Array(3*size*size)
 * - normalize: (pixel/255 - 0.5) / 0.5  即 [-1, 1]（ArcFace insightface 默认）
 */
export async function alignFace(
  imageBuffer: Buffer,
  bbox: BBox,
  imageWidth: number,
  imageHeight: number,
  opts: AlignerOptions = {},
): Promise<Float32Array> {
  const expand = opts.expand ?? 1.3;
  const size = opts.size ?? 112;

  const region = expandBBox(bbox, imageWidth, imageHeight, expand);

  const cropped = await sharp(imageBuffer, { failOn: "none" })
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .resize(size, size, { fit: "fill", withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer();

  // raw RGB HWC, length = size*size*3
  const expected = size * size * 3;
  if (cropped.length !== expected) {
    throw new Error(`alignFace: 期望 raw 像素 ${expected} bytes，实得 ${cropped.length}`);
  }

  // HWC uint8 → CHW float32, normalize to [-1, 1]
  const out = new Float32Array(expected);
  const hw = size * size;
  for (let i = 0; i < hw; i++) {
    const r = cropped[i * 3] ?? 0;
    const g = cropped[i * 3 + 1] ?? 0;
    const b = cropped[i * 3 + 2] ?? 0;
    out[i] = (r / 255 - 0.5) / 0.5; // R 通道
    out[hw + i] = (g / 255 - 0.5) / 0.5; // G 通道
    out[2 * hw + i] = (b / 255 - 0.5) / 0.5; // B 通道
  }
  return out;
}
