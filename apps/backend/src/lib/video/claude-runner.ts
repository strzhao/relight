/**
 * claude CLI runner（spawn claude -p 调 memory-video skill）。
 *
 * 后端首次引入 child_process spawn（参照 src/cli/vlog-frame-extract.ts:125 的 spawn 模式）。
 *
 * 契约（设计文档「claude -p 调用契约」）：
 * - spawn 用绝对路径 `config.claudeCliPath`（不依赖 PATH——PM2 resurrect 时 nvm 不在 PATH）
 * - cwd = `config.videoWorkspacePath`（Remotion 项目根）
 * - spawn 前三存在校验：node_modules + render-immersive.mjs + ~/.claude/skills/memory-video/SKILL.md
 * - AbortController + 1200s 超时 + SIGTERM + 清理 .tmp mp4
 * - 失败不降级、不重试渲染（返回 err 让 job 写 failed 行）
 */
import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { config } from "../config";

/** spawn 超时（ms）——dry-run 实测 20 张照片 ~1156s，给 1.5x 余量防 LLM 延迟偶发超时 */
const SPAWN_TIMEOUT_MS = 1800_000;

/** 主题描述（trip 传 photoIds / person 传 personId+截止年） */
export interface VideoTheme {
  themeKind: "trip" | "person";
  themeKey: string;
  titleHint: string;
  /** trip：photoId 列表；person：personId（单元素） */
  photoIds: string[];
  personId?: string;
  toYear: number;
}

/** spawn 产物元数据（skill 写的 json：title/durationSec/photoIds） */
export interface VideoMeta {
  title: string;
  durationSec: number;
  photoIds: string[];
}

/** runVideoGeneration 返回 */
export interface VideoGenResult {
  ok: boolean;
  meta?: VideoMeta;
  err?: string;
}

/** spawn 前三存在校验：node_modules + render-immersive.mjs + SKILL.md */
export async function assertSpawnPrerequisites(): Promise<void> {
  const ws = config.videoWorkspacePath;
  const checks: Array<{ label: string; p: string }> = [
    { label: "node_modules", p: path.join(ws, "node_modules") },
    { label: "render-immersive.mjs", p: path.join(ws, "render-immersive.mjs") },
    {
      label: "memory-video SKILL.md",
      p: path.join(homedir(), ".claude/skills/memory-video/SKILL.md"),
    },
  ];
  for (const c of checks) {
    try {
      await access(c.p);
    } catch {
      throw new Error(`spawn 前置缺失: ${c.label} (${c.p})`);
    }
  }
}

/** 构造 claude -p 的 prompt（按设计文档 prompt 契约） */
function buildPrompt(theme: VideoTheme, outputPath: string, metaPath: string): string {
  const material =
    theme.themeKind === "trip"
      ? `素材池（${theme.photoIds.length} 张 photoId，按美学降序）：${theme.photoIds.join(" ")}。你按旅行丰富度自主选最终片数（≥20 张，素材多就做完整 vlog，不限上限；别只取 top 也别全硬塞）`
      : `素材：personId=${theme.personId} 截止年=${theme.toYear}`;
  return [
    "用 memory-video skill 生成视频，非交互自动化模式。",
    `主题：${theme.themeKind} / ${theme.themeKey}（${theme.titleHint}）`,
    material,
    `产物：mp4 → ${outputPath}`,
    `      元数据 → ${metaPath}（title/durationSec/photoIds）`,
    "约束：直接出 1080p（不 dry-run 不预览）；原图缺失→非零退出（不降级缩略图）。",
  ].join("\n");
}

/**
 * spawn claude -p 生成视频。
 *
 * 成功：mp4 + json 落盘到约定路径，返回 {ok:true, meta}。
 * 失败：超时/非零退出/产物缺失 → 返回 {ok:false, err}，清理 .tmp。
 *
 * 不降级、不重试渲染（上层 job 写 failed 行）。
 */
export async function runVideoGeneration(
  theme: VideoTheme,
  outputPath: string,
  metaPath: string,
): Promise<VideoGenResult> {
  // 1. 前置校验
  try {
    await assertSpawnPrerequisites();
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }

  if (!config.claudeCliPath) {
    return { ok: false, err: "config.claudeCliPath 为空（claude 未安装且未设 CLAUDE_CLI_PATH）" };
  }

  const prompt = buildPrompt(theme, outputPath, metaPath);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SPAWN_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(config.claudeCliPath, ["-p", prompt], {
        cwd: config.videoWorkspacePath,
        env: {
          ...process.env,
          HOME: homedir(),
          PATH: process.env.PATH ?? "",
          // 产物路径同时以环境变量传出（真实 skill 读 prompt 文本解析；
          // 测试 stub / 简化脚本可直接读环境变量，契约两边都满足）
          OUTPUT_PATH: outputPath,
          META_PATH: metaPath,
          THEME_KIND: theme.themeKind,
          THEME_KEY: theme.themeKey,
          COVER_PATH: path.join(
            path.dirname(outputPath),
            `${theme.themeKind}-${theme.themeKey}.jpg`,
          ),
        },
        signal: ac.signal,
        killSignal: "SIGTERM",
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      // 清理 .tmp mp4（可能渲染到一半）
      await cleanupTmp(outputPath).catch(() => {});
      return {
        ok: false,
        err: `claude -p 退出码 ${exitCode}（stderr=${stderr.slice(-500) || "（空）"}）`,
      };
    }

    // 2. 校验 mp4 产物存在
    try {
      await access(outputPath);
    } catch {
      return { ok: false, err: `mp4 产物缺失: ${outputPath}` };
    }

    // 3. 读元数据 json
    let meta: VideoMeta | undefined;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<VideoMeta>;
      meta = {
        title: parsed.title ?? theme.titleHint,
        durationSec: parsed.durationSec ?? 0,
        photoIds: parsed.photoIds ?? theme.photoIds,
      };
    } catch {
      // 元数据缺失不视为失败（mp4 已生成），用 fallback 值
      meta = {
        title: theme.titleHint,
        durationSec: 0,
        photoIds: theme.photoIds,
      };
    }

    return { ok: true, meta };
  } catch (e) {
    await cleanupTmp(outputPath).catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, err: ac.signal.aborted ? `claude -p 超时（${SPAWN_TIMEOUT_MS}ms）` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 清理 .tmp mp4（渲染中断的半成品） */
async function cleanupTmp(outputPath: string): Promise<void> {
  // skill 渲染通常用 .tmp 后缀或同名 + .partial
  const candidates = [`${outputPath}.tmp`, `${outputPath}.partial`, outputPath];
  for (const p of candidates) {
    try {
      await access(p);
      await rm(p, { force: true });
    } catch {
      // 不存在忽略
    }
  }
}
