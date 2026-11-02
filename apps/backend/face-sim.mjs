/** ArcFace 逐帧人脸相似度：与各自 f0（首帧）比 cos 相似度，对比单/双锚定的漂移。 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ort from "onnxruntime-node";

const ROOT = "/Users/stringzhao/workspace/relight";
const MODEL = path.join(ROOT, "apps/backend/assets/models/arcface_mbf.onnx");

async function embed(session, rawPath) {
  const buf = fs.readFileSync(rawPath); // 112*112*3 rgb
  const data = new Float32Array(3 * 112 * 112);
  // ArcFace 预处理：(x - 127.5) / 127.5，通道序按模型（mbf 常见 CHW RGB）
  const CHW = true;
  for (let i = 0; i < 112 * 112; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (buf[i * 3 + c] - 127.5) / 127.5;
      data[CHW ? c * 112 * 112 + i : i * 3 + c] = v;
    }
  }
  const feeds = {};
  feeds[session.inputNames[0]] = new ort.Tensor("float32", data, [1, 3, 112, 112]);
  const out = await session.run(feeds);
  return Array.from(out[session.outputNames[0]].data);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

async function main() {
  const session = await ort.InferenceSession.create(MODEL);
  const frames = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 106];
  const lines = [
    `frame ${["dual.baby", "single.baby", "dual.dad", "single.dad"].map((h) => h.padStart(11)).join(" ")}`,
  ];
  const base = {};
  for (const who of ["baby", "dad"]) {
    for (const tag of ["dual", "single"]) {
      base[`${tag}.${who}`] = await embed(session, `/tmp/shiguang/faceeval/${tag}/f0.${who}.raw`);
    }
  }
  for (const f of frames) {
    const row = [String(f).padStart(5)];
    for (const key of ["dual.baby", "single.baby", "dual.dad", "single.dad"]) {
      const [tag, who] = key.split(".");
      const e = await embed(session, `/tmp/shiguang/faceeval/${tag}/f${f}.${who}.raw`);
      row.push(cosine(base[key], e).toFixed(4).padStart(11));
    }
    lines.push(row.join(" "));
  }
  console.log(lines.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
