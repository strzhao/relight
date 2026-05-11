/**
 * ArcFace MobileFaceNet embedding 提取器。
 *
 * 输入：alignFace 已生成的 NCHW Float32Array(1*3*112*112)
 * 输出：L2-normalized Float32Array(512)
 *
 * **[!] embedFace 在没有真模型时无法 round-trip 验证；契约清楚 input/output shape**
 * 真实场景跑通后需要：
 *   1. 同一张脸两次 embed 应该 cosine ~ 1.0
 *   2. 不同人脸 cosine 应该 < 0.5
 */
import { type FaceTensor, getSession } from "./session";

const ARCFACE_INPUT_SIZE = 112;
const ARCFACE_OUTPUT_DIM = 512;

/** L2 normalize 到单位向量（in-place 拷贝返回） */
export function l2Normalize(arr: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] ?? 0;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  const out = new Float32Array(arr.length);
  if (norm === 0) return out;
  for (let i = 0; i < arr.length; i++) {
    out[i] = (arr[i] ?? 0) / norm;
  }
  return out;
}

/**
 * 对一张已对齐的脸 (CHW Float32) 计算 512 维 embedding。
 *
 * 输入张量约定：3 * 112 * 112 = 37632 个 float
 */
export async function embedFace(alignedTensor: Float32Array): Promise<Float32Array> {
  const expectedLen = 3 * ARCFACE_INPUT_SIZE * ARCFACE_INPUT_SIZE;
  if (alignedTensor.length !== expectedLen) {
    throw new Error(
      `embedFace: 输入张量长度 ${alignedTensor.length} != 期望 ${expectedLen} (3*${ARCFACE_INPUT_SIZE}*${ARCFACE_INPUT_SIZE})`,
    );
  }

  const session = await getSession("arcface");
  // ArcFace insightface 默认 input 名为 "input.1"
  const inputName = "input.1";
  const inputTensor: FaceTensor = {
    data: alignedTensor,
    dims: [1, 3, ARCFACE_INPUT_SIZE, ARCFACE_INPUT_SIZE],
    type: "float32",
  };
  const outputs = await session.run({ [inputName]: inputTensor });

  // 默认输出 shape (1, 512)；用第一个 tensor 兜底
  const tensorList = Object.values(outputs);
  const first = tensorList[0];
  if (!first || first.data.length < ARCFACE_OUTPUT_DIM) {
    throw new Error(`embedFace: 模型输出维度异常 ${first?.data.length ?? 0}`);
  }

  const raw =
    first.data.length === ARCFACE_OUTPUT_DIM
      ? first.data
      : first.data.subarray(0, ARCFACE_OUTPUT_DIM);

  return l2Normalize(raw);
}
