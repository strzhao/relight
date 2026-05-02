import fs from "node:fs/promises";
import { evaluateResponse } from "../ai/evaluation/evaluator";
import { parseAnalysisResponse } from "../ai/response-parser";

/**
 * 评估 CLI
 *
 * 用法: tsx src/cli/evaluate.ts <response-file>
 *
 * 读取一个包含 AI 原始响应的文件，解析并评估结果。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("用法: tsx src/cli/evaluate.ts <response-file>");
    console.error("  <response-file> 包含 AI 原始响应的文件路径");
    process.exit(1);
  }

  const filePath = args[0] ?? "";

  try {
    const rawResponse = await fs.readFile(filePath, "utf-8");

    console.log("=".repeat(60));
    console.log("AI 响应评估");
    console.log("=".repeat(60));
    console.log(`文件: ${filePath}`);
    console.log(`响应长度: ${rawResponse.length} 字符`);

    // 解析
    const { parsed, error, fallback } = parseAnalysisResponse(rawResponse);

    console.log("\n--- 解析结果 ---");
    if (parsed) {
      console.log("状态: 解析成功");
      console.log(`叙事描述: ${parsed.narrative.slice(0, 80)}...`);
      console.log(`美学评分: ${parsed.aestheticScore}`);
      console.log(`标签数: ${parsed.tags.length}`);
      console.log(`构图类型: ${parsed.composition.type}`);
      console.log(`色彩情绪: ${parsed.colorAnalysis.mood}`);
      console.log(`主导情感: ${parsed.emotionalAnalysis.primary}`);
    } else {
      console.log(`状态: 解析失败 - ${error}`);
      console.log("使用容错默认值继续评分...");
    }

    // 评估
    const result = evaluateResponse(parsed, rawResponse, error);

    console.log("\n--- 评分结果 ---");
    console.log(`总分: ${result.totalScore}/${result.maxScore}`);
    console.log(`判定: ${result.passed ? "通过" : "未通过"}`);
    console.log(`摘要: ${result.summary}`);

    console.log("\n--- 维度详情 ---");
    for (const dim of result.dimensions) {
      console.log(`\n[${dim.name}] ${dim.score}/${dim.maxScore}`);
      for (const detail of dim.details) {
        console.log(`  ${detail}`);
      }
    }

    console.log(`\n${"=".repeat(60)}`);

    // 用作脚本退出码
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    console.error(`读取文件失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

main();
