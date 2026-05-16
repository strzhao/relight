import fs from "node:fs/promises";
import path from "node:path";
import { analyzeImage } from "./vlog/lib/analyzeImage";
import { analyzeVideo, defaultSpriteDir } from "./vlog/lib/analyzeVideo";
import { detectPersonsInMedia } from "./vlog/lib/detect-persons";
import type { PersonsResult } from "./vlog/lib/detect-persons";
import { transcribeFile } from "./vlog/lib/transcribe";
import { classifyFile, err, pLimit } from "./vlog/lib/util";
import type { BatchManifest, ManifestImageEntry, ManifestVideoEntry } from "./vlog/types";
import { batchManifestSchema } from "./vlog/types";

interface CliOpts {
  rootDir: string | null;
  out?: string;
  fileConcurrency: number;
  themeHint?: string;
  skipTranscribe: boolean;
  skipAi: boolean;
  promptVersion?: string;
  whisperModel?: string;
  whisperLanguage?: string;
  whisperWordTimestamps: boolean;
  filter?: string;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    rootDir: null,
    fileConcurrency: 3,
    skipTranscribe: false,
    skipAi: false,
    whisperWordTimestamps: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--concurrency") opts.fileConcurrency = Number(argv[++i]);
    else if (a === "--theme-hint") opts.themeHint = argv[++i];
    else if (a === "--skip-transcribe") opts.skipTranscribe = true;
    else if (a === "--no-ai") opts.skipAi = true;
    else if (a === "--prompt-version") opts.promptVersion = argv[++i];
    else if (a === "--whisper-model") opts.whisperModel = argv[++i];
    else if (a === "--whisper-language") opts.whisperLanguage = argv[++i];
    else if (a === "--no-word-timestamps") opts.whisperWordTimestamps = false;
    else if (a === "--filter") opts.filter = argv[++i];
    else if (a && !a.startsWith("--") && opts.rootDir === null) opts.rootDir = a;
  }
  return opts;
}

async function listFiles(rootDir: string, filterRegex?: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  const re = filterRegex ? new RegExp(filterRegex) : null;
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(rootDir, entry.name);
    if (re && !re.test(entry.name)) continue;
    files.push(full);
  }
  return files.sort();
}

/**
 * Phase 0: 对所有媒体文件做人脸识别，收集 personsByFile 和 autoPersonNames。
 * 单文件失败 → 该文件 persons:[]，整批不中断。
 */
async function phase0DetectPersons(
  mediaFiles: string[],
  concurrency: number,
): Promise<{
  personsByFile: Map<string, PersonsResult>;
  autoPersonNames: Set<string>;
}> {
  const personsByFile = new Map<string, PersonsResult>();
  const autoPersonNames = new Set<string>();

  if (mediaFiles.length === 0) {
    return { personsByFile, autoPersonNames };
  }

  err(`[detect-persons] starting phase 0 for ${mediaFiles.length} files`);

  const limit = pLimit<void>(concurrency);
  let done = 0;

  const tasks = mediaFiles.map((filePath) =>
    limit(async () => {
      const kind = classifyFile(filePath);
      const mediaType = kind === "image" ? "image" : kind === "video" ? "video" : null;
      if (!mediaType) {
        done++;
        return;
      }

      let result: PersonsResult;
      try {
        result = await detectPersonsInMedia(filePath, mediaType, {});
      } catch {
        result = { persons: [], status: "no_faces" };
      }

      personsByFile.set(filePath, result);
      for (const p of result.persons) {
        if (p.name) autoPersonNames.add(p.name);
      }

      done++;
      err(`[detect-persons] ${done}/${mediaFiles.length} files processed`);
    }),
  );

  await Promise.all(tasks);
  return { personsByFile, autoPersonNames };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.rootDir) {
    err(
      "用法: tsx src/cli/vlog-batch-index.ts <directory> [--out manifest.json] [--concurrency 3] [--theme-hint '…'] [--skip-transcribe] [--no-ai] [--prompt-version v2] [--whisper-model large-v3-turbo] [--whisper-language auto] [--no-word-timestamps] [--filter '<regex>']",
    );
    process.exit(1);
  }
  const rootDir = path.resolve(opts.rootDir);
  err(
    `[batch-index] root=${rootDir} concurrency=${opts.fileConcurrency} skipTranscribe=${opts.skipTranscribe}`,
  );

  const allFiles = await listFiles(rootDir, opts.filter);
  err(`[batch-index] discovered ${allFiles.length} files`);

  // Phase 0: 人脸识别（在 analyze + transcribe 之前）
  const mediaFiles = allFiles.filter((f) => {
    const kind = classifyFile(f);
    return kind === "image" || kind === "video";
  });
  const { personsByFile, autoPersonNames } = await phase0DetectPersons(
    mediaFiles,
    opts.fileConcurrency,
  );

  // 合并 WHISPER_INITIAL_PROMPT：autoPersonNames + env prompt → 去重 → 顿号分隔
  const envPrompt = process.env.WHISPER_INITIAL_PROMPT ?? "";
  const finalPrompt = mergeWhisperPrompt([...autoPersonNames], envPrompt);
  process.env.WHISPER_INITIAL_PROMPT = finalPrompt;
  err(`[batch-index] initialPrompt auto-merged: "${finalPrompt}"`);

  const t0 = Date.now();
  const limit = pLimit<ManifestImageEntry | ManifestVideoEntry | null>(opts.fileConcurrency);
  const spriteOutDir = await defaultSpriteDir();
  let processed = 0;
  let failed = 0;
  let cacheHits = 0;

  const tasks = allFiles.map((filePath) =>
    limit(async () => {
      const kind = classifyFile(filePath);
      try {
        if (kind === "image") {
          const r = await analyzeImage(filePath, {
            promptVersion: opts.promptVersion,
            skipAi: opts.skipAi,
          });
          if (r.cacheHit) cacheHits++;
          if (!r.ok) failed++;
          processed++;
          err(
            `[batch-index] ${processed}/${allFiles.length} image ${path.basename(filePath)} ok=${r.ok} cache=${r.cacheHit} ${r.elapsedMs}ms`,
          );
          const personsResult = personsByFile.get(filePath);
          const entry: ManifestImageEntry = {
            ...(r as ManifestImageEntry),
            persons: personsResult?.persons,
            personsStatus: personsResult?.status,
          };
          return entry;
        }
        if (kind === "video") {
          // Transcribe + analyze in parallel (different resources: whisper vs qwen)
          const transcribePromise: Promise<Awaited<ReturnType<typeof transcribeFile>> | null> =
            opts.skipTranscribe
              ? Promise.resolve(null)
              : transcribeFile(filePath, {
                  model: opts.whisperModel,
                  language: opts.whisperLanguage,
                  wordTimestamps: opts.whisperWordTimestamps,
                });

          // We can't pass transcript to analyze yet (parallel race) — first version: analyze without transcript.
          const analyzePromise = analyzeVideo(filePath, {
            promptVersion: opts.promptVersion,
            skipAi: opts.skipAi,
            spriteOutDir,
          });

          const [analysis, transcript] = await Promise.all([analyzePromise, transcribePromise]);
          if (analysis.cacheHit) cacheHits++;
          if (transcript?.cacheHit) cacheHits++;
          if (!analysis.ok) failed++;

          const personsResult = personsByFile.get(filePath);
          const merged: ManifestVideoEntry = {
            ...analysis,
            transcript: transcript
              ? {
                  language: transcript.language,
                  text: transcript.text,
                  segments: transcript.segments,
                  srt: transcript.srt,
                  model: transcript.model,
                  hasWordTimestamps: transcript.hasWordTimestamps,
                }
              : undefined,
            persons: personsResult?.persons,
            personsStatus: personsResult?.status,
          };
          processed++;
          err(
            `[batch-index] ${processed}/${allFiles.length} video ${path.basename(filePath)} ok=${analysis.ok} cache=${analysis.cacheHit} ${analysis.elapsedMs}ms tx_segs=${transcript?.segments.length ?? "skip"}`,
          );
          return merged;
        }
        err(`[batch-index] skip non-media: ${path.basename(filePath)}`);
        return null;
      } catch (e) {
        failed++;
        processed++;
        err(`[batch-index] ERROR ${path.basename(filePath)}: ${(e as Error).message}`);
        return null;
      }
    }),
  );

  const results = (await Promise.all(tasks)).filter(
    (r): r is ManifestImageEntry | ManifestVideoEntry => r !== null,
  );

  const elapsedMs = Date.now() - t0;
  const images = results.filter((r) => r.type === "image").length;
  const videos = results.filter((r) => r.type === "video").length;
  const ok = results.filter((r) => r.ok).length;

  const manifest: BatchManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rootDir,
    themeHint: opts.themeHint,
    files: results,
    stats: {
      total: results.length,
      images,
      videos,
      ok,
      failed,
      elapsedMs,
      cacheHits,
    },
  };

  const validated = batchManifestSchema.parse(manifest);
  const json = JSON.stringify(validated, null, 2);

  if (opts.out) {
    const outPath = path.resolve(opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, json, "utf-8");
    err(`[batch-index] wrote manifest → ${outPath}`);
  }

  process.stdout.write(`${json}\n`);
  err(
    `[batch-index] DONE total=${results.length} images=${images} videos=${videos} ok=${ok} failed=${failed} cacheHits=${cacheHits} elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
  );
}

export function mergeWhisperPrompt(autoNames: string[], envPrompt: string): string {
  const envTerms = envPrompt.split(/[、,，\s]+/).filter(Boolean);
  const allTerms = [...autoNames.filter(Boolean), ...envTerms];
  return Array.from(new Set(allTerms)).join("、");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    err("FATAL", (e as Error).stack ?? (e as Error).message);
    process.exit(1);
  });
}
