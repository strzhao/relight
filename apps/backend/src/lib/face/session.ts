/**
 * ONNX InferenceSession 单例 + 懒加载 + 可注入工厂（测试钩子）。
 *
 * 设计要点：
 * - **不在模块顶层调用** `InferenceSession.create`，避免 import 时阻塞 + 强制需要模型文件
 * - 暴露 `getSession(modelKind)` 给运行时调用方，缺失模型时抛 clear error
 * - 暴露 `setSessionFactory(fn)` 给测试用，注入 mock session（绕开 onnxruntime-node）
 * - macOS 自动尝试启用 CoreML EP（ANE 加速）；其他平台 CPU
 * - 模型路径优先 `process.env.MODELS_DIR`，否则 fallback 到 `apps/backend/assets/models/`
 *
 * 模型缺失场景：worker 启动前 fs.access 检查，缺失 warn + 不抛错
 * （contract 要求"模型缺失降级 = 不阻断主流程"）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** ONNX session 抽象（仅用 run + 元数据，便于测试 mock） */
export interface FaceSession {
  /** EP 列表（实测后 console.log 给运维参考） */
  providers?: string[];
  /** 推理：input -> output 张量 map */
  run(feeds: Record<string, FaceTensor>): Promise<Record<string, FaceTensor>>;
}

/** 简化 tensor 抽象（onnxruntime-node 的 Tensor 子集） */
export interface FaceTensor {
  data: Float32Array;
  dims: number[];
  type: "float32";
}

export type ModelKind = "scrfd" | "arcface";

// 文件名与 download-models.ts 保持一致；
// SCRFD-500M 是实际可下载的 ONNX 变体（设计文档原写 2.5G，但公开 ONNX 镜像没有 2.5G）
const MODEL_FILES: Record<ModelKind, string> = {
  scrfd: "scrfd_500m.onnx",
  arcface: "arcface_mbf.onnx",
};

let factory: ((modelKind: ModelKind, modelPath: string) => Promise<FaceSession>) | null = null;
const cache = new Map<ModelKind, Promise<FaceSession>>();

/** 测试钩子：注入 mock session 工厂，避免实际加载 ONNX */
export function setSessionFactory(
  fn: ((modelKind: ModelKind, modelPath: string) => Promise<FaceSession>) | null,
): void {
  factory = fn;
  cache.clear();
}

/** 解析模型目录（MODELS_DIR env 优先 → 否则相对 backend 包） */
export function getModelsDir(): string {
  if (process.env.MODELS_DIR) return path.resolve(process.env.MODELS_DIR);
  const __filename = fileURLToPath(import.meta.url);
  // src/lib/face/session.ts → ../../../assets/models
  return path.resolve(path.dirname(__filename), "..", "..", "..", "assets", "models");
}

/** 获取模型权重的绝对路径（不验证是否存在） */
export function getModelPath(modelKind: ModelKind): string {
  return path.join(getModelsDir(), MODEL_FILES[modelKind]);
}

/** 模型权重是否存在（worker 启动时检查） */
export async function modelFileExists(modelKind: ModelKind): Promise<boolean> {
  const p = getModelPath(modelKind);
  try {
    await fs.promises.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 默认工厂：动态 import onnxruntime-node 创建 session */
async function defaultFactory(modelKind: ModelKind, modelPath: string): Promise<FaceSession> {
  if (!fs.existsSync(modelPath)) {
    throw new Error(
      `[face] 模型文件不存在: ${modelPath}\n请运行 \`pnpm --filter @relight/backend models:download\` 下载模型。`,
    );
  }
  const ort = await import("onnxruntime-node");
  const executionProviders = process.platform === "darwin" ? ["coreml", "cpu"] : ["cpu"];
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders,
    graphOptimizationLevel: "all",
  });
  // contract 要求：第一次 create 后必须 console.log EPs
  // session.handler 在不同 onnxruntime-node 版本里字段不同，用宽松断言
  // biome-ignore lint/suspicious/noExplicitAny: ORT internals not strongly typed
  const providers = (session as any).providers ?? executionProviders;
  console.log(`[face] EPs: ${JSON.stringify(providers)} (model=${modelKind})`);

  // 包装成 FaceSession 接口
  return {
    providers,
    async run(feeds) {
      // biome-ignore lint/suspicious/noExplicitAny: ort.InferenceSession 严格 OnnxValueMapType，运行期实测兼容
      const ortFeeds: Record<string, any> = {};
      for (const [k, v] of Object.entries(feeds)) {
        ortFeeds[k] = new ort.Tensor("float32", v.data, v.dims);
      }
      const result = await session.run(ortFeeds);
      const out: Record<string, FaceTensor> = {};
      for (const [k, v] of Object.entries(result)) {
        // onnxruntime Tensor 字段：data, dims, type
        // biome-ignore lint/suspicious/noExplicitAny: ORT Tensor not strongly typed
        const t = v as any;
        out[k] = { data: t.data as Float32Array, dims: t.dims as number[], type: "float32" };
      }
      return out;
    },
  };
}

/** 获取（懒加载，单例缓存） InferenceSession */
export async function getSession(modelKind: ModelKind): Promise<FaceSession> {
  let cached = cache.get(modelKind);
  if (!cached) {
    const f = factory ?? defaultFactory;
    cached = f(modelKind, getModelPath(modelKind));
    cache.set(modelKind, cached);
  }
  return cached;
}

/** 测试 / shutdown 用：清缓存 */
export function resetSessionCache(): void {
  cache.clear();
}
