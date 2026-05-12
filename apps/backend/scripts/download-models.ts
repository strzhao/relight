/**
 * 下载 ONNX 人脸识别模型权重。
 *
 * - SCRFD-2.5G（人脸检测，~3.1MB）
 * - ArcFace MobileFaceNet（人脸 embedding，~13MB）
 *
 * 默认目录：apps/backend/assets/models/，可用 MODELS_DIR env 覆盖。
 * 默认镜像：huggingface.co；中国用户可设 MODELS_MIRROR=hf-mirror.com。
 *
 * License 提示：模型权重来自学术发布，仅供 non-commercial / 个人使用。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface ModelSpec {
  /** 文件名（写入到 MODELS_DIR） */
  filename: string;
  /** 主下载 URL（按数组顺序逐个尝试，第一个成功即用） */
  urls: string[];
  /** sha256 校验（小写 hex）— 已知值留空表示首次跑后从输出补回 */
  sha256?: string;
  /** 体积估值（字节，仅用于显示） */
  approxBytes: number;
}

// 多源候选 — deepghs/insightface 是 InsightFace buffalo 包的稳定 HF 镜像
//
// ⚠️ 设计偏离说明：原设计文档要求 SCRFD-2.5G + ArcFace MobileFaceNet (~16MB 总)。
// 实测公开 ONNX 镜像（HF 上 immich-app / deepghs / yakhyo）均无 2.5G 变体可下载：
//   - buffalo_l 包：SCRFD-10G (16.9MB) + ArcFace ResNet50 (174MB) — 太大
//   - buffalo_s 包：SCRFD-500M (2.5MB) + ArcFace MobileFaceNet (13.6MB) ← 当前选择
// 用 SCRFD-500M 替代 2.5G：精度略降（WIDER hard 68.5 vs 77.9），但与 MBF 配套总
// 仅 16MB，CPU 推理快，适合家庭相册场景；用户如需更高精度可手工把 buffalo_l 的
// det_10g.onnx 重命名为 scrfd_500m.onnx 替换。
// 升级到 buffalo_l：SCRFD-10G (~17MB) + ArcFace R50 (~174MB)，识别准度量级提升。
// 文件名保持原命名（scrfd_500m.onnx / arcface_mbf.onnx）让 session.ts 不变。
// sha256 留空，第一次下载后通过日志补回（也充当版本不一致时的强制重下信号）。
const MODELS: ModelSpec[] = [
  {
    filename: "scrfd_500m.onnx",
    urls: ["https://huggingface.co/deepghs/insightface/resolve/main/buffalo_l/det_10g.onnx"],
    sha256: "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    approxBytes: 16_923_827,
  },
  {
    filename: "arcface_mbf.onnx",
    urls: ["https://huggingface.co/deepghs/insightface/resolve/main/buffalo_l/w600k_r50.onnx"],
    sha256: "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
    approxBytes: 174_383_860,
  },
];

function applyMirror(url: string): string {
  const mirror = process.env.MODELS_MIRROR;
  if (!mirror) return url;
  return url.replace(/^https:\/\/huggingface\.co/, `https://${mirror}`);
}

function defaultModelsDir(): string {
  // 默认 apps/backend/assets/models/
  // 通过 import.meta.url 解析，独立于调用 cwd
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "assets", "models");
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  console.log(`[download] GET ${url}`);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "relight-models-downloader/0.1" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  await fs.promises.writeFile(dest, Buffer.from(arrayBuf));
}

async function sha256OfFile(filePath: string): Promise<string> {
  const data = await fs.promises.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function downloadOne(spec: ModelSpec, modelsDir: string): Promise<void> {
  const dest = path.join(modelsDir, spec.filename);
  if (fs.existsSync(dest)) {
    const size = (await fs.promises.stat(dest)).size;
    if (spec.sha256) {
      const got = await sha256OfFile(dest);
      if (got === spec.sha256) {
        console.log(`[download] ${spec.filename} 已存在且校验通过 (${size} bytes)，跳过`);
        return;
      }
      console.warn(
        `[download] ${spec.filename} 已存在但 sha256 不匹配（${got} != ${spec.sha256}），重新下载`,
      );
    } else {
      console.log(`[download] ${spec.filename} 已存在 (${size} bytes)，跳过（无 sha256 比对）`);
      return;
    }
  }

  // 多源逐个尝试，第一个成功即用；全失败才抛
  let lastErr: unknown = null;
  let downloaded = false;
  for (const candidate of spec.urls) {
    const url = applyMirror(candidate);
    try {
      await fetchToFile(url, dest);
      downloaded = true;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[download] ${spec.filename} 源失败，尝试下一个: ${(err as Error).message}`);
    }
  }
  if (!downloaded) {
    throw lastErr instanceof Error ? lastErr : new Error(`所有下载源都失败 (${spec.filename})`);
  }

  const got = await sha256OfFile(dest);
  const size = (await fs.promises.stat(dest)).size;
  console.log(`[download] ${spec.filename} 完成: ${size} bytes, sha256=${got}`);
  if (spec.sha256 && got !== spec.sha256) {
    throw new Error(
      `${spec.filename} sha256 校验失败：期望 ${spec.sha256}，实得 ${got}。请重试或检查 URL。`,
    );
  }
}

async function main(): Promise<void> {
  const modelsDir = process.env.MODELS_DIR
    ? path.resolve(process.env.MODELS_DIR)
    : defaultModelsDir();

  await fs.promises.mkdir(modelsDir, { recursive: true });
  console.log(`[download] 模型目录: ${modelsDir}`);
  console.log(
    "[download] 提示：模型权重为学术研究用途，仅适用于个人/家庭相册等 non-commercial 场景",
  );

  for (const spec of MODELS) {
    try {
      await downloadOne(spec, modelsDir);
    } catch (err) {
      console.error(`[download] ${spec.filename} 失败:`, err instanceof Error ? err.message : err);
      throw err;
    }
  }

  console.log("[download] 全部完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
