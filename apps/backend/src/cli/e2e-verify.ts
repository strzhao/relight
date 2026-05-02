import fs from "node:fs/promises";
import sharp from "sharp";
import { aiClient } from "../ai/client";
import { loadPrompts } from "../ai/prompts";
import { parseAnalysisResponse } from "../ai/response-parser";
import { evaluateResponse } from "../ai/evaluation/evaluator";

async function main(): Promise<void> {
  const photoPath = process.argv[2];
  if (!photoPath) {
    console.error("用法: npx tsx src/cli/e2e-verify.ts <照片路径>");
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("  端到端验证 —— 照片 AI 分析全链路");
  console.log("=".repeat(60));
  console.log(`照片: ${photoPath}`);

  // Step 1: 加载 Prompt
  const promptVersion = "v1";
  const prompts = await loadPrompts(promptVersion);
  console.log(`Prompt 版本: ${promptVersion}`);
  console.log(`System prompt: ${prompts.system.length} 字符`);
  console.log(`User prompt: ${prompts.user.length} 字符`);

  // Step 2: 读取 + 缩放照片 → base64
  const stat = await fs.stat(photoPath);
  console.log(`原始文件大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  let imageBuffer = await fs.readFile(photoPath);
  const metadata = await sharp(imageBuffer).metadata();
  console.log(`原始尺寸: ${metadata.width}x${metadata.height}, 格式: ${metadata.format}`);

  // 限制最大边长 2048px，控制 base64 体积
  const MAX_DIM = 2048;
  if ((metadata.width ?? 0) > MAX_DIM || (metadata.height ?? 0) > MAX_DIM) {
    imageBuffer = await sharp(imageBuffer)
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    console.log(`缩放后大小: ${(imageBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  }

  const base64 = imageBuffer.toString("base64");
  console.log(`Base64 长度: ${(base64.length / 1024).toFixed(0)} KB`);

  // Step 3: 调用 AI 视觉模型
  const fullPrompt = `${prompts.system}\n\n${prompts.user}`;
  console.log(`\n--- 正在调用 AI 模型 (qwen3.6-35b) ---`);
  const startTime = Date.now();

  const rawResponse = await aiClient.analyzePhoto(base64, "image/jpeg", fullPrompt);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`AI 响应耗时: ${elapsed}s`);
  console.log(`原始响应长度: ${rawResponse.length} 字符`);

  // Step 4: 解析响应
  const parseResult = parseAnalysisResponse(rawResponse);

  if (parseResult.error) {
    console.log(`\n⚠️ 解析警告: ${parseResult.error}`);
  }

  const data = parseResult.parsed || parseResult.fallback;
  const usedFallback = parseResult.parsed === null;
  console.log(`\n${usedFallback ? "⚠️ 使用容错结果" : "✅ 解析成功"} (${usedFallback ? "部分字段回退默认值" : "Zod 校验通过"})`);

  // Step 5: 展示分析结果
  console.log("\n" + "─".repeat(60));
  console.log("  📸 分析结果");
  console.log("─".repeat(60));

  console.log(`\n【叙事描述】(${data.narrative.length} 字)`);
  console.log(`  ${data.narrative}`);

  console.log(`\n【美学评分】${data.aestheticScore}/10`);

  console.log(`\n【标签】(${data.tags.length} 个)`);
  for (const t of data.tags) {
    console.log(`  • ${t.name} (${t.category}) — 置信度: ${(t.confidence * 100).toFixed(0)}%`);
  }

  console.log(`\n【构图分析】`);
  console.log(`  类型: ${data.composition.type}`);
  console.log(`  评分: ${data.composition.score}/10`);
  console.log(`  描述: ${data.composition.description}`);
  // subjects 字段在 design v1 schema 中可选，AI 可能不输出
  const subjects = (data.composition as Record<string, unknown>).subjects as string[] | undefined;
  if (subjects?.length) console.log(`  主体: ${subjects.join(", ")}`);

  console.log(`\n【色彩分析】`);
  console.log(`  色板: ${data.colorAnalysis.palette.join(", ")}`);
  console.log(`  主调: ${data.colorAnalysis.dominant}`);
  console.log(`  氛围: ${data.colorAnalysis.mood}`);

  console.log(`\n【情感分析】`);
  console.log(`  主要情感: ${data.emotionalAnalysis.primary}`);
  console.log(`  次要情感: ${data.emotionalAnalysis.secondary}`);
  console.log(`  强度: ${data.emotionalAnalysis.intensity}/10`);
  const keywords = (data.emotionalAnalysis as Record<string, unknown>).keywords as string[] | undefined;
  if (keywords?.length) console.log(`  关键词: ${keywords.join(", ")}`);

  console.log(`\n【使用建议】`);
  console.log(`  ${data.usageSuggestions}`);

  // Step 6: 量化评估
  console.log("\n" + "─".repeat(60));
  console.log("  📊 量化验收 (5维度 × 20分 = 100分)");
  console.log("─".repeat(60));

  const result = evaluateResponse(data, rawResponse, null);
  console.log(`\n  总分: ${result.totalScore}/100 ${result.passed ? "✅" : "❌"}`);
  for (const d of result.dimensions) {
    const icon = d.score >= 16 ? "✅" : d.score >= 10 ? "⚠️" : "❌";
    console.log(`  ${icon} ${d.name}: ${d.score}/20`);
    for (const detail of d.details) {
      console.log(`     ${detail}`);
    }
  }

  // 最终结论
  console.log("\n" + "=".repeat(60));
  console.log("  验收结论");
  console.log("=".repeat(60));

  const checks: { label: string; ok: boolean }[] = [
    { label: "AI 服务可达 (qwen3.6-35b multimodal)", ok: true },
    { label: "响应 JSON 解析成功", ok: !parseResult.error?.includes("未能从响应中提取") },
    { label: "标签 ≥ 7 个 (7 类覆盖)", ok: data.tags.length >= 7 },
    { label: "叙事描述 50-200 中文", ok: data.narrative.length >= 50 && data.narrative.length <= 200 },
    { label: "美学评分 1-10", ok: data.aestheticScore >= 1 && data.aestheticScore <= 10 },
    { label: "标签类别有效", ok: data.tags.every((t) => {
      const valid = ["scene", "emotion", "people", "color", "event", "object", "style"];
      return valid.includes(t.category);
    })},
    { label: "量化评分 ≥ 60", ok: result.totalScore >= 60 },
    { label: "Zod 校验通过", ok: !usedFallback },
  ];

  let passCount = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? "✅" : "❌"} ${c.label}`);
    if (c.ok) passCount++;
  }

  console.log(`\n  ${passCount}/${checks.length} 项通过`);
  if (passCount === checks.length) {
    console.log("\n  🎉 全链路验证通过！照片 AI 分析管线工作正常。");
  } else {
    console.log(`\n  ⚠️ ${checks.length - passCount} 项未通过，需排查。`);
  }

  console.log(`\n  总耗时: ${elapsed}s | Prompt 版本: ${promptVersion}`);
}

main().catch((err) => {
  console.error("执行失败:", err);
  process.exit(1);
});
