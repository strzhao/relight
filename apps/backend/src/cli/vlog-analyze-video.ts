import { analyzeVideo, defaultSpriteDir } from "./vlog/lib/analyzeVideo";
import { err } from "./vlog/lib/util";

function parseArgs(argv: string[]): {
  filePath: string | null;
  promptVersion?: string;
  frames?: number;
  skipAi: boolean;
  cacheOnly: boolean;
  spriteOutDir?: string;
  transcriptHint?: string;
} {
  let filePath: string | null = null;
  let promptVersion: string | undefined;
  let frames: number | undefined;
  let skipAi = false;
  let cacheOnly = false;
  let spriteOutDir: string | undefined;
  let transcriptHint: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-version") {
      promptVersion = argv[++i];
    } else if (a === "--frames") {
      frames = Number(argv[++i]);
    } else if (a === "--no-ai") {
      skipAi = true;
    } else if (a === "--cache-only") {
      cacheOnly = true;
    } else if (a === "--sprite-out-dir") {
      spriteOutDir = argv[++i];
    } else if (a === "--transcript") {
      transcriptHint = argv[++i];
    } else if (a && !a.startsWith("--") && filePath === null) {
      filePath = a;
    }
  }
  return { filePath, promptVersion, frames, skipAi, cacheOnly, spriteOutDir, transcriptHint };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    err(
      "用法: tsx src/cli/vlog-analyze-video.ts <videoPath> [--prompt-version v2] [--frames 6] [--no-ai] [--cache-only] [--sprite-out-dir <dir>] [--transcript <text>]",
    );
    process.exit(1);
  }
  err(`[vlog-analyze-video] start: ${args.filePath}`);
  const spriteOutDir = args.spriteOutDir ?? (await defaultSpriteDir());
  const result = await analyzeVideo(args.filePath, {
    promptVersion: args.promptVersion,
    frames: args.frames,
    skipAi: args.skipAi,
    cacheOnly: args.cacheOnly,
    spriteOutDir,
    transcriptHint: args.transcriptHint,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});
