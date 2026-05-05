import fs from "node:fs/promises";
import sharp from "sharp";
import { aiClient } from "../src/ai/client";
import { evaluateResponse } from "../src/ai/evaluation/evaluator";
import { loadPrompts } from "../src/ai/prompts";
import { parseAnalysisResponse } from "../src/ai/response-parser";

async function main(): Promise<void> {
  const photoPath = process.argv[2];
  if (!photoPath) {
    console.error("用法: tsx measure-analyze-latency.ts <绝对路径>");
    process.exit(1);
  }

  const stat = await fs.stat(photoPath);
  console.log(`原始文件: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  const t0 = Date.now();
  let buffer = await fs.readFile(photoPath);
  buffer = await sharp(buffer)
    .resize(1024, 1024, { fit: "inside" })
    .jpeg({ quality: 75 })
    .toBuffer();
  const t1 = Date.now();
  console.log(`缩放后: ${(buffer.length / 1024).toFixed(0)} KB (耗时 ${t1 - t0}ms)`);

  const base64 = buffer.toString("base64");
  const prompts = await loadPrompts("v2");

  const t2 = Date.now();
  const raw = await aiClient.analyzePhoto(base64, "image/jpeg", prompts.system, prompts.user);
  const t3 = Date.now();
  console.log(`AI 调用耗时: ${((t3 - t2) / 1000).toFixed(2)}s`);
  console.log(`响应长度: ${raw.length} chars`);

  const { parsed, error, fallback } = parseAnalysisResponse(raw);
  if (error) console.log(`解析告警: ${error}`);
  const result = parsed ?? fallback;

  const fields = {
    tags: Array.isArray(result.tags) ? result.tags.length : 0,
    aestheticScore: typeof result.aestheticScore === "number" ? result.aestheticScore : null,
    composition: !!result.composition,
    colorAnalysis: !!result.colorAnalysis,
    emotionalAnalysis: !!result.emotionalAnalysis,
    narrative: !!result.narrative,
  };
  console.log("解析后字段:", JSON.stringify(fields));

  const evalRes = evaluateResponse(result, raw, error);
  console.log(`评估总分: ${evalRes.totalScore}/100`);

  const totalMs = t3 - t0;
  console.log("=".repeat(50));
  console.log(`端到端总耗时: ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`期望 < 25s: ${totalMs < 25000 ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`字段完整性: tags≥3=${fields.tags >= 3 ? "✅" : "❌"}(${fields.tags}), score=${fields.aestheticScore !== null ? "✅" : "❌"}, composition=${fields.composition ? "✅" : "❌"}, colorAnalysis=${fields.colorAnalysis ? "✅" : "❌"}`);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
