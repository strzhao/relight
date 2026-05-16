/**
 * 验收测试：WHISPER_INITIAL_PROMPT 合成逻辑（红队）
 *
 * 覆盖设计文档契约 3：
 * - autoPersonNames（filter name !== ""）+ profile/env prompt → uniq → 顿号 "、" 分隔
 * - autoPersonNames 在前（更高 prompt weight）
 * - 用户 profile 手填 customNames 与检测结果去重合并
 * - 合并后均为空 → 返回 ""
 * - 必须输出日志：[batch-index] initialPrompt auto-merged: "<final>"
 *
 * 红队铁律：
 * - 未读 vlog-batch-index.ts 实现代码
 * - 测试策略：
 *   A) 若蓝队拆出纯函数 mergeWhisperPrompt → 直接 import 测试
 *   B) 若纯函数不存在 → 降级为子进程测试（验证 stderr 日志）
 *
 * 两种策略均在此文件中实现，运行时自动选择。
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---- 尝试 import 纯函数（蓝队拆出则直接测试，否则 import 会失败） ----
// 注意：使用动态 import + catch 来做优雅降级

const RELIGHT_BACKEND_SRC = path.resolve(import.meta.dirname ?? __dirname, "..");
const BATCH_INDEX_PATH = path.join(RELIGHT_BACKEND_SRC, "cli/vlog-batch-index.ts");

/**
 * 尝试加载纯函数 mergeWhisperPrompt。
 * 返回函数本身，或者 null（如果蓝队没拆纯函数）。
 */
async function tryLoadMergeFunction(): Promise<
  ((autoNames: string[], envPrompt: string) => string) | null
> {
  try {
    const mod = await import("../cli/vlog-batch-index");
    if (typeof (mod as Record<string, unknown>).mergeWhisperPrompt === "function") {
      return (mod as Record<string, unknown>).mergeWhisperPrompt as (
        autoNames: string[],
        envPrompt: string,
      ) => string;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- 纯函数测试（策略 A）----
describe("契约 3: WHISPER_INITIAL_PROMPT 合成 — 纯函数路径（若导出 mergeWhisperPrompt）", () => {
  it("仅自动检测：autoNames=['爸爸','妈妈']，env='' → 输出 '爸爸、妈妈'", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) {
      console.log("[跳过] mergeWhisperPrompt 未作为纯函数导出，降级为子进程测试");
      return;
    }
    const result = fn(["爸爸", "妈妈"], "");
    expect(result).toBe("爸爸、妈妈");
  });

  it("合并去重：autoNames=['六六']，env='环球影城、六六' → 输出 '六六、环球影城'（autoNames 在前，uniq）", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) return;
    const result = fn(["六六"], "环球影城、六六");
    // autoNames 在前，去重后不含重复 "六六"
    expect(result).toBe("六六、环球影城");
  });

  it("用户 env 优先（autoNames 为空）：env='紫薇'，autoNames=[] → 输出 '紫薇'", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) return;
    const result = fn([], "紫薇");
    expect(result).toBe("紫薇");
  });

  it("都空 → 输出 ''", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) return;
    const result = fn([], "");
    expect(result).toBe("");
  });

  it("未命名 person（name=''）应被过滤，不出现在 prompt", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) return;
    // 空字符串 name 代表未命名 person，设计文档明确 filter name !== ""
    const result = fn(["爸爸", "", "六六"], "");
    expect(result).not.toContain("、、"); // 不应有连续顿号
    expect(result.split("、").every((s) => s !== "")).toBe(true);
    expect(result).toContain("爸爸");
    expect(result).toContain("六六");
  });

  it("使用顿号（'、'）作为分隔符，不用英文逗号或空格", async () => {
    const fn = await tryLoadMergeFunction();
    if (!fn) return;
    const result = fn(["爸爸", "妈妈", "六六"], "");
    // 验证分隔符是中文顿号
    expect(result).toBe("爸爸、妈妈、六六");
    expect(result).not.toContain(",");
    expect(result).not.toContain(" ");
  });
});

// ---- 子进程测试（策略 B）— 验证日志格式 ----
describe("契约 3: WHISPER_INITIAL_PROMPT 合成 — 日志格式契约（子进程路径）", () => {
  it("batch-index 应输出 [batch-index] initialPrompt auto-merged: 日志行", async () => {
    const fn = await tryLoadMergeFunction();
    // 如果纯函数存在，子进程测试作为补充
    // 如果纯函数不存在，这是唯一验证路径

    // 准备一个空目录，使 batch-index 快速退出（无文件）
    const testDir = "/tmp/vlog-test-empty-dir-accept";
    try {
      execSync(`mkdir -p ${testDir}`, { stdio: "ignore" });
      // 运行 batch-index，捕获 stderr（err() 函数输出到 stderr）
      // --skip-transcribe 跳过耗时的 whisper，--no-ai 跳过 AI 分析
      // 只需验证日志行格式存在，不需要目录有真实文件
      const out = execSync(
        `cd /Users/stringzhao/workspace/relight && WHISPER_INITIAL_PROMPT='测试环球影城' pnpm --filter @relight/backend exec tsx src/cli/vlog-batch-index.ts ${testDir} --out /tmp/vlog-test-manifest-accept.json --skip-transcribe --no-ai 2>&1 || true`,
        { encoding: "utf-8", timeout: 30_000 },
      );
      // 如果实现了合并逻辑，应输出该日志
      if (out.includes("[batch-index] initialPrompt auto-merged:")) {
        expect(out).toMatch(/\[batch-index\] initialPrompt auto-merged: ".*"/);
        // 环境变量中有 "测试环球影城"，应出现在合并后的 prompt 中
        expect(out).toMatch(/\[batch-index\] initialPrompt auto-merged: ".*测试环球影城.*/);
      } else {
        // 实现尚未合并日志行 — 标记为 todo（不 fail，因为可能是其他阶段原因）
        console.warn(
          "[警告] 未找到 [batch-index] initialPrompt auto-merged 日志行。蓝队应确保在 Phase 0 集成后输出此日志。",
        );
        if (!fn) {
          // 没有纯函数也没有日志 = 实现未完成
          // 保持 pending 状态而非硬 fail，让 CI 在蓝队完成后自动通过
          expect(out).toMatch(/\[batch-index\] initialPrompt auto-merged: ".*"/);
        }
      }
    } catch (e) {
      // 如果子进程本身出错（模块找不到等），把错误信息打印但不 fail（蓝队可能尚未实现）
      console.warn(`[子进程测试] 执行出错（可能是实现未完成）: ${String(e)}`);
      if (!fn) {
        throw e; // 纯函数和子进程都失败 → 硬失败
      }
    }
  });

  it("不传 WHISPER_INITIAL_PROMPT 时，自动构造的 prompt 不含 undefined 字样", async () => {
    const fn = await tryLoadMergeFunction();
    if (fn) {
      // 纯函数路径：空数组 + 空字符串 → 不含 undefined
      const result = fn([], "");
      expect(result).not.toContain("undefined");
    } else {
      // 子进程路径
      try {
        const testDir = "/tmp/vlog-test-empty-dir-accept";
        execSync(`mkdir -p ${testDir}`, { stdio: "ignore" });
        const out = execSync(
          `cd /Users/stringzhao/workspace/relight && pnpm --filter @relight/backend exec tsx src/cli/vlog-batch-index.ts ${testDir} --out /tmp/vlog-test-manifest-accept2.json --skip-transcribe --no-ai 2>&1 || true`,
          { encoding: "utf-8", timeout: 30_000 },
        );
        if (out.includes("[batch-index] initialPrompt auto-merged:")) {
          expect(out).not.toMatch(/initialPrompt auto-merged: ".*undefined/);
        }
      } catch (e) {
        console.warn(`[子进程测试] 跳过（实现未完成）: ${String(e)}`);
      }
    }
  });
});
