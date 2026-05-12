import { analyzeImage } from "./vlog/lib/analyzeImage";
import { err } from "./vlog/lib/util";

function parseArgs(argv: string[]): {
  filePath: string | null;
  promptVersion?: string;
  skipAi: boolean;
  cacheOnly: boolean;
} {
  let filePath: string | null = null;
  let promptVersion: string | undefined;
  let skipAi = false;
  let cacheOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt-version") {
      promptVersion = argv[++i];
    } else if (a === "--no-ai") {
      skipAi = true;
    } else if (a === "--cache-only") {
      cacheOnly = true;
    } else if (a && !a.startsWith("--") && filePath === null) {
      filePath = a;
    }
  }
  return { filePath, promptVersion, skipAi, cacheOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    err(
      "用法: tsx src/cli/vlog-analyze-image.ts <imagePath> [--prompt-version v2] [--no-ai] [--cache-only]",
    );
    process.exit(1);
  }
  err(`[vlog-analyze-image] start: ${args.filePath}`);
  const result = await analyzeImage(args.filePath, {
    promptVersion: args.promptVersion,
    skipAi: args.skipAi,
    cacheOnly: args.cacheOnly,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});
