import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import pLimit from "p-limit";
import sharp from "sharp";
import { config } from "../lib/config";
import { convertHeicToJpeg, isHeicBuffer, isHeicFile } from "../lib/heic";
import { err } from "./vlog/lib/util";

const DIANPING_VISION_PROMPT = `你是一位有10年经验的中餐厨师。请从专业技术角度分析这张菜品图片，不要只描述"看起来像什么菜"。请逐项回答：

1. 【菜名识别】这是什么菜？（结合可见食材和做法判断）

2. 【火候判断】
   - 表面焦化/美拉德反应程度（均匀度、颜色深浅：浅金→深棕→焦黑）
   - 肉类切面熟度（粉色→灰色→白色）
   - 盘中余油量（干爽/正常/偏油）
   - 食材表面的油光状态

3. 【食材判断】
   - 肉类：纹理粗细、脂肪分布、色泽新鲜度
   - 蔬菜：翠绿/暗沉、切面新鲜度、是否脱水
   - 海鲜：透明感、弹性外观、完整度
   - 任何不新鲜或品质下降的视觉迹象

4. 【调味判断】
   - 酱汁光泽（亮面=油量/糖量足、哑光=偏干）
   - 颜色层次（单一 vs 复合，判断香料/酱料复杂度）
   - 可见配料（辣椒段/花椒粒/蒜瓣/葱段/姜片等，用量和状态）
   - 酱汁稠度（挂壁浓稠/稀薄流动态/已分层）
   - 收汁程度（酱汁在食材表面还是沉在盘底）

5. 【做法判断】
   - 刀工（均匀度、形状：片/丝/丁/块、是否有碎渣）
   - 摆盘（布局、装饰、餐具选择——是否用心）
   - 烹饪痕迹（蒸痕、烤痕、炸衣状态、煎烤网格纹）
   - 面衣/挂糊状态（厚度、均匀度、酥脆感外观）

6. 【分量判断】
   - 食材与餐具/盘子的比例
   - 与常见同类型菜品分量的对比（偏少/正常/偏多）

7. 【整体判断】
   - 这道菜的水准在什么档次？（家常/中档餐厅/高级餐厅）
   - 从技术角度最大的亮点是什么？最大的缺陷是什么？
   - 有什么细节一般食客会忽略但专业厨师会注意到的？

请全部用中文回答。每个判断都要基于图片中实际可见的证据。`;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif"]);

interface Args {
  paths: string[];
  folder?: string;
  concurrency: number;
  output?: string;
  maxEdge: number;
  maxTokens: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    paths: [],
    concurrency: 4,
    maxEdge: 1568,
    maxTokens: 4096,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--folder") args.folder = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--max-edge") args.maxEdge = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--max-tokens") args.maxTokens = Number.parseInt(argv[++i] ?? "", 10);
    else if (a && !a.startsWith("--")) args.paths.push(a);
  }
  return args;
}

async function listFolderImages(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (IMAGE_EXTS.has(ext)) files.push(path.join(folder, e.name));
  }
  return files.sort();
}

const client = new OpenAI({
  baseURL: config.ai.baseUrl,
  apiKey: config.ai.apiKey,
  timeout: 180_000,
  maxRetries: 0,
});

async function prepareImage(filePath: string, maxEdge: number): Promise<string> {
  let buf = await readFile(filePath);
  if (isHeicFile(filePath) || isHeicBuffer(buf)) {
    buf = await convertHeicToJpeg(buf, { quality: 90 });
  }
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const needResize = w > maxEdge || h > maxEdge;
  const notJpeg = meta.format !== "jpeg" && meta.format !== "jpg";
  if (needResize || notJpeg) {
    let pipeline = sharp(buf);
    if (needResize) {
      pipeline = pipeline.resize(maxEdge, maxEdge, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    buf = await pipeline.jpeg({ quality: 85 }).toBuffer();
  }
  return buf.toString("base64");
}

async function analyzeOne(filePath: string, maxEdge: number, maxTokens: number): Promise<string> {
  const b64 = await prepareImage(filePath, maxEdge);
  const params = {
    model: config.ai.visionModel,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image_url" as const,
            image_url: { url: `data:image/jpeg;base64,${b64}` },
          },
          { type: "text" as const, text: DIANPING_VISION_PROMPT },
        ],
      },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
    chat_template_kwargs: { enable_thinking: false } as const,
  };
  const response = await client.chat.completions.create(params);
  const msg = response.choices[0]?.message;
  const text = msg?.content || (msg as unknown as Record<string, string>)?.reasoning_content || "";
  if (!text.trim()) {
    throw new Error("empty vision response (no content or reasoning_content)");
  }
  const finish = response.choices[0]?.finish_reason;
  if (finish === "length") {
    err(
      `[dianping-vision] WARN: finish_reason=length on ${path.basename(filePath)} — consider raising --max-tokens`,
    );
  }
  return text;
}

interface ResultItem {
  image: string;
  index: number;
  analysis?: string;
  error?: string;
  elapsedMs: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let images = [...args.paths];
  if (args.folder) {
    const more = await listFolderImages(args.folder);
    images = images.concat(more);
  }
  if (images.length === 0) {
    err(
      "用法: tsx src/cli/dianping-vision.ts [<imagePath>...] [--folder <dir>] [--concurrency 4] [--output <jsonFile>] [--max-edge 1568] [--max-tokens 4096]",
    );
    process.exit(1);
  }

  err(
    `[dianping-vision] start: ${images.length} images, concurrency=${args.concurrency}, model=${config.ai.visionModel}, endpoint=${config.ai.baseUrl}`,
  );
  const t0 = Date.now();
  const limit = pLimit(args.concurrency);
  let done = 0;
  const results: ResultItem[] = await Promise.all(
    images.map((img, idx) =>
      limit(async () => {
        const s = Date.now();
        try {
          const analysis = await analyzeOne(img, args.maxEdge, args.maxTokens);
          const elapsedMs = Date.now() - s;
          done++;
          err(
            `[dianping-vision] ${done}/${images.length} ok: ${path.basename(img)} (${elapsedMs}ms)`,
          );
          return { image: img, index: idx, analysis, elapsedMs };
        } catch (e) {
          const elapsedMs = Date.now() - s;
          done++;
          const message = (e as Error).message;
          err(
            `[dianping-vision] ${done}/${images.length} FAIL: ${path.basename(img)} (${elapsedMs}ms) — ${message}`,
          );
          return { image: img, index: idx, error: message, elapsedMs };
        }
      }),
    ),
  );
  results.sort((a, b) => a.index - b.index);

  const success = results.filter((r) => r.error == null).length;
  const failed = results.length - success;
  const out = {
    ok: failed === 0,
    totalMs: Date.now() - t0,
    stats: { total: results.length, success, failed },
    results,
  };
  const json = JSON.stringify(out, null, 2);
  process.stdout.write(`${json}\n`);
  if (args.output) {
    await writeFile(args.output, json);
    err(`[dianping-vision] wrote ${args.output}`);
  }

  if (failed === results.length) process.exit(1);
  if (failed > 0) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});
