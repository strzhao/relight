/**
 * 壁纸视频生成画布 SSOT（20260928 单腿原生比例，state.md ## 设计文档 D1 / ## 实现绑定表）
 *
 * computeNativeCanvas(origW, origH) → {width, height}：
 *   生成画布跟随 hero 原图比例（32 取整 + 像素预算封顶），竖图横图统一处理：
 *   归一化长短轴比 R 恒 ≥1，朝向（landscape/portrait）由原图独立决定。
 *
 * 引擎事实（已验证）：mmh3turbo `--width/--height` 逐轴覆盖档位（须 32 倍数）；
 * 锚定帧 LANCZOS 直接拉伸到画布（不裁剪）→ 调用方预裁比例必须精确等于画布比例；
 * fps 恒 24；输出画布与输入图尺寸无关。
 *
 * 算法（design D1 伪代码 1:1 落地）：
 *   R      = clamp(max(w,h)/min(w,h), 1.0, 2.40)
 *   主循环: L（长轴候选）从 1600 按 32 递减
 *     s = round32(L / R)
 *     若 L*s ≤ BUDGET 且 s ≥ MIN_SHORT → 按朝向返回
 *   兜底（极端比例，主循环恒不满足）:
 *     L = round32(min(MIN_SHORT*R, BUDGET/MIN_SHORT))（回退防溢出预算）, s = MIN_SHORT
 *
 * 参考输出（四舍五入 round32）：1:1→1056×1056；3:2→1312×864；16:9→1440×800；
 * 9:16→800×1440；4:3→1248×928；3:4→928×1248；2.35:1→1664×704；比例偏差全部 ≤1.3%。
 */

/** 像素预算 = 736×1600（现行竖版像素上限，注意力 token 等价预算） */
export const NATIVE_CANVAS_PIXEL_BUDGET = 1_177_600;
/** 引擎质量纪律下限（短轴 ≥700 纪律取 32 倍数档 704） */
export const NATIVE_CANVAS_MIN_SHORT = 704;
/** 长短轴比 clamp 上界（超过按 2.40 处理，防止全景图产出极端窄条） */
export const NATIVE_CANVAS_MAX_RATIO = 2.4;
/** 长轴候选起点（预算内最大常见档） */
const MAX_LONG = 1600;
const STEP = 32;

/** 四舍五入到 32 的倍数（mmh3turbo 画布约束） */
function round32(n: number): number {
  return Math.round(n / STEP) * STEP;
}

export interface NativeCanvas {
  width: number;
  height: number;
}

/**
 * 由 hero 原图尺寸计算单腿原生生成画布（width×height，均 32 倍数）。
 *
 * @param origW hero 原图宽（EXIF 旋转后像素）
 * @param origH hero 原图高（EXIF 旋转后像素）
 * @throws Error 原图尺寸非法（非正数/非有限）
 */
export function computeNativeCanvas(origW: number, origH: number): NativeCanvas {
  if (!Number.isFinite(origW) || !Number.isFinite(origH) || origW <= 0 || origH <= 0) {
    throw new Error(`computeNativeCanvas 原图尺寸非法: ${origW}×${origH}`);
  }
  // 归一化长短轴比：恒 ≥1（竖图横图统一处理），朝向与 R 解耦
  const r = Math.min(
    NATIVE_CANVAS_MAX_RATIO,
    Math.max(1, Math.max(origW, origH) / Math.min(origW, origH)),
  );
  const landscape = origW >= origH;

  // 主循环：长轴候选从 1600 按 32 递减，找首个「像素 ≤ 预算 且 短轴 ≥ 下限」的组合
  for (let long = MAX_LONG; long >= NATIVE_CANVAS_MIN_SHORT; long -= STEP) {
    const short = round32(long / r);
    if (long * short <= NATIVE_CANVAS_PIXEL_BUDGET && short >= NATIVE_CANVAS_MIN_SHORT) {
      return landscape ? { width: long, height: short } : { width: short, height: long };
    }
  }

  // 兜底（极端比例：round32(L/R) 在全域 < MIN_SHORT）：短轴钉在 MIN_SHORT，
  // 长轴 = round32(min(MIN_SHORT*R, BUDGET/MIN_SHORT))；round32 向上取整可能溢出预算，
  // 再按 32 递减兜回（保证像素 ≤ BUDGET）
  let long = round32(
    Math.min(NATIVE_CANVAS_MIN_SHORT * r, NATIVE_CANVAS_PIXEL_BUDGET / NATIVE_CANVAS_MIN_SHORT),
  );
  while (long * NATIVE_CANVAS_MIN_SHORT > NATIVE_CANVAS_PIXEL_BUDGET && long > STEP) {
    long -= STEP;
  }
  return landscape
    ? { width: long, height: NATIVE_CANVAS_MIN_SHORT }
    : { width: NATIVE_CANVAS_MIN_SHORT, height: long };
}
