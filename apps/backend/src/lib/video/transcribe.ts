import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";

export interface WhisperCapability {
  pythonOk: boolean;
  scriptOk: boolean;
  /** 综合可用性：pythonOk && scriptOk && config.whisper.enabled */
  available: boolean;
}

export interface TranscribeResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

let _whisperCapability: WhisperCapability | null = null;

/**
 * 检测 Whisper 依赖（python 可执行 + 脚本文件）。
 * 结果缓存，进程生命周期内只检测一次。
 */
export async function detectWhisperCapability(): Promise<WhisperCapability> {
  if (_whisperCapability) return _whisperCapability;

  const [pythonOk, scriptOk] = await Promise.all([
    checkAccess(config.whisper.python),
    checkAccess(config.whisper.script),
  ]);

  _whisperCapability = {
    pythonOk,
    scriptOk,
    available: pythonOk && scriptOk && config.whisper.enabled,
  };
  return _whisperCapability;
}

async function checkAccess(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 调用 Whisper CLI 对 WAV 文件进行语音识别。
 *
 * 关键：脚本将结果写入 `<outputDir>/<basename>.json`，
 * stdout 是人类可读的进度日志，绝对不解析 stdout。
 * 等进程退出（exitCode===0）后读 JSON 文件。
 *
 * 超时 300s。
 */
export async function transcribeAudio(
  audioPath: string,
  opts?: { language?: string; model?: string },
): Promise<TranscribeResult | null> {
  const tmpDir = path.join(
    os.tmpdir(),
    `relight-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const python = config.whisper.python;
    const script = config.whisper.script;
    const engine = config.whisper.engine;
    const model = opts?.model ?? config.whisper.model;
    const language = opts?.language ?? config.whisper.language;

    const args = [
      script,
      audioPath,
      "--engine",
      engine,
      "--model",
      model,
      "--language",
      language,
      "--output-format",
      "json",
      "--output-dir",
      tmpDir,
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });

      // stdout/stderr 是人类可读日志，不解析，只记录
      proc.stdout?.on("data", () => {});
      proc.stderr?.on("data", () => {});

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Whisper 超时（300s）"));
      }, 300_000);

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Whisper 退出码 ${code}`));
        } else {
          resolve();
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // 读取 JSON 结果文件
    const stem = path.basename(audioPath, path.extname(audioPath));
    const jsonPath = path.join(tmpDir, `${stem}.json`);
    const raw = await fs.readFile(jsonPath, "utf-8");
    const data = JSON.parse(raw) as { text?: string; segments?: unknown[] };

    const text = data.text ?? "";
    const segments = Array.isArray(data.segments)
      ? (data.segments as Array<{ start?: number; end?: number; text?: string }>).map((s) => ({
          start: Number(s.start ?? 0),
          end: Number(s.end ?? 0),
          text: String(s.text ?? "").trim(),
        }))
      : [];

    return { text: text.trim(), segments };
  } catch {
    return null;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
