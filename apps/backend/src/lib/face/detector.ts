/**
 * SCRFD 人脸检测器。
 *
 * 输入：原图 buffer（任意尺寸），输出：Face[]（含 bbox + 检测分数）。
 *
 * 流程：
 * 1. sharp 把图缩放到 640×640（CoreML EP 要求 fixed shape），保持原 aspect ratio + letterbox padding
 * 2. 转成 NCHW Float32（1,3,640,640），normalize 到 [-1, 1]（mean=127.5, std=128）
 * 3. session.run → 9 个输出 tensor（3 strides × {score, bbox, kps}）
 * 4. anchor decode + NMS（IoU > 0.4）
 * 5. 反推到原图坐标 + 过滤 < minFaceSize 的小脸
 *
 * **[!] 当前为骨架实现：步骤 3-5 标记 TODO。** 真实场景需要在带模型的环境中按
 * https://github.com/yakhyo/face-reidentification/blob/main/scrfd.py
 * 直译大约 80 行 TS，并用真实图片做 sanity check。
 */
import sharp from "sharp";
import { config } from "../config";
import { type FaceTensor, getSession } from "./session";

export interface DetectedFace {
  /** bbox 在原图坐标下（像素） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** SCRFD 检测分数 [0, 1] */
  score: number;
}

export interface DetectOptions {
  /** 检测分数阈值，默认 config.face.detectionThreshold */
  scoreThreshold?: number;
  /** 最小脸边长（像素），默认 config.face.minFaceSize */
  minSize?: number;
  /** SCRFD 输入尺寸（必须与模型一致；CoreML EP 需要固定 640） */
  inputSize?: number;
}

const SCRFD_INPUT_SIZE = 640;

/** Letterbox preprocess：缩放保持 aspect ratio，填灰边到 inputSize */
async function preprocess(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  inputSize: number,
): Promise<{ tensor: Float32Array; scale: number; padX: number; padY: number }> {
  const scale = Math.min(inputSize / imageWidth, inputSize / imageHeight);
  const newW = Math.round(imageWidth * scale);
  const newH = Math.round(imageHeight * scale);
  const padX = Math.floor((inputSize - newW) / 2);
  const padY = Math.floor((inputSize - newH) / 2);

  const resized = await sharp(imageBuffer)
    .resize(newW, newH, { fit: "fill" })
    .extend({
      top: padY,
      bottom: inputSize - newH - padY,
      left: padX,
      right: inputSize - newW - padX,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer();

  const total = inputSize * inputSize;
  const tensor = new Float32Array(3 * total);
  for (let i = 0; i < total; i++) {
    const r = resized[i * 3] ?? 0;
    const g = resized[i * 3 + 1] ?? 0;
    const b = resized[i * 3 + 2] ?? 0;
    // SCRFD insightface preprocessing: (x - 127.5) / 128
    tensor[i] = (r - 127.5) / 128;
    tensor[total + i] = (g - 127.5) / 128;
    tensor[2 * total + i] = (b - 127.5) / 128;
  }
  return { tensor, scale, padX, padY };
}

/** IoU 计算 */
function iou(a: DetectedFace, b: DetectedFace): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** 简化 NMS（greedy） */
function nms(faces: DetectedFace[], iouThreshold = 0.4): DetectedFace[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: DetectedFace[] = [];
  for (const f of sorted) {
    if (kept.every((k) => iou(f, k) < iouThreshold)) {
      kept.push(f);
    }
  }
  return kept;
}

/** SCRFD anchor 元数据（每个 stride 2 个 anchor） */
const STRIDES = [8, 16, 32];
const ANCHORS_PER_STRIDE = 2;

/**
 * SCRFD 后处理：从 9 个 tensor 解出 bbox + score 列表。
 *
 * 输出 tensor 命名约定（按 insightface scrfd onnx 默认）：
 *   stride 8:  score_8 (1, A*H*W, 1), bbox_8 (1, A*H*W, 4)
 *   stride 16: 同上
 *   stride 32: 同上
 *
 * 实际不同模型导出的输出名可能不同；这里按"按 dims 形状识别"的兜底策略。
 *
 * **[!] 此函数当前实现保守 — 在没有真模型校验前可能 anchor 偏移有误差。**
 * 真实场景下需要：
 *   1. console.log Object.keys(outputs) 看实际 tensor 名
 *   2. 对照 insightface scrfd.py 的 distance2bbox + decode 逻辑
 */
function decodeOutputs(
  outputs: Record<string, FaceTensor>,
  inputSize: number,
  scoreThreshold: number,
): DetectedFace[] {
  const candidates: DetectedFace[] = [];
  const tensorEntries = Object.entries(outputs);

  for (const stride of STRIDES) {
    const featSize = inputSize / stride;
    const featArea = featSize * featSize;
    const numAnchors = featArea * ANCHORS_PER_STRIDE;

    // 按 dims 找到该 stride 的 score / bbox tensor
    const scoreTensor = tensorEntries.find(
      ([_, t]) => t.dims.length >= 2 && t.dims[1] === numAnchors && (t.dims[2] ?? 1) === 1,
    )?.[1];
    const bboxTensor = tensorEntries.find(
      ([_, t]) => t.dims.length >= 2 && t.dims[1] === numAnchors && t.dims[2] === 4,
    )?.[1];

    if (!scoreTensor || !bboxTensor) {
      continue; // 该 stride 输出未识别，跳过
    }

    for (let i = 0; i < numAnchors; i++) {
      const score = scoreTensor.data[i] ?? 0;
      if (score < scoreThreshold) continue;

      const anchorIdx = Math.floor(i / ANCHORS_PER_STRIDE);
      const ay = Math.floor(anchorIdx / featSize);
      const ax = anchorIdx % featSize;
      const cx = (ax + 0.5) * stride;
      const cy = (ay + 0.5) * stride;

      // bbox tensor 是 distance-to-center [l, t, r, b] (单位 stride)
      const l = (bboxTensor.data[i * 4] ?? 0) * stride;
      const t = (bboxTensor.data[i * 4 + 1] ?? 0) * stride;
      const r = (bboxTensor.data[i * 4 + 2] ?? 0) * stride;
      const b = (bboxTensor.data[i * 4 + 3] ?? 0) * stride;

      const x1 = cx - l;
      const y1 = cy - t;
      const x2 = cx + r;
      const y2 = cy + b;

      candidates.push({
        x: x1,
        y: y1,
        w: x2 - x1,
        h: y2 - y1,
        score,
      });
    }
  }
  return candidates;
}

/** 把 letterbox 坐标反推到原图坐标 */
function unletterbox(
  faces: DetectedFace[],
  scale: number,
  padX: number,
  padY: number,
  imageWidth: number,
  imageHeight: number,
): DetectedFace[] {
  return faces
    .map((f) => {
      const x = (f.x - padX) / scale;
      const y = (f.y - padY) / scale;
      const w = f.w / scale;
      const h = f.h / scale;
      return {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        w: Math.min(imageWidth - Math.max(0, Math.round(x)), Math.round(w)),
        h: Math.min(imageHeight - Math.max(0, Math.round(y)), Math.round(h)),
        score: f.score,
      };
    })
    .filter((f) => f.w > 0 && f.h > 0);
}

/**
 * 检测照片中的人脸。
 *
 * 调用方需先用 sharp metadata 拿到原图 width/height。
 * 返回的 bbox 都是原图坐标系下的整数像素值。
 */
export async function detectFaces(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  opts: DetectOptions = {},
): Promise<DetectedFace[]> {
  const scoreThreshold = opts.scoreThreshold ?? config.face.detectionThreshold;
  const minSize = opts.minSize ?? config.face.minFaceSize;
  const inputSize = opts.inputSize ?? SCRFD_INPUT_SIZE;

  const { tensor, scale, padX, padY } = await preprocess(
    imageBuffer,
    imageWidth,
    imageHeight,
    inputSize,
  );

  const session = await getSession("scrfd");
  // SCRFD 默认 input 名为 "input.1"，不同导出可能不同；测试钩子可适配
  const inputName = "input.1";
  const outputs = await session.run({
    [inputName]: { data: tensor, dims: [1, 3, inputSize, inputSize], type: "float32" },
  });

  const candidates = decodeOutputs(outputs, inputSize, scoreThreshold);
  const original = unletterbox(candidates, scale, padX, padY, imageWidth, imageHeight);
  const filtered = original.filter((f) => f.w >= minSize && f.h >= minSize);
  return nms(filtered, 0.4);
}
