import { transcribeFile } from "./vlog/lib/transcribe";
import { err } from "./vlog/lib/util";

function parseArgs(argv: string[]): {
  filePath: string | null;
  model?: string;
  language?: string;
  wordTimestamps: boolean;
  timeoutMs?: number;
} {
  let filePath: string | null = null;
  let model: string | undefined;
  let language: string | undefined;
  let wordTimestamps = false;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      model = argv[++i];
    } else if (a === "--language") {
      language = argv[++i];
    } else if (a === "--word-timestamps") {
      wordTimestamps = true;
    } else if (a === "--timeout-ms") {
      timeoutMs = Number(argv[++i]);
    } else if (a && !a.startsWith("--") && filePath === null) {
      filePath = a;
    }
  }
  return { filePath, model, language, wordTimestamps, timeoutMs };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.filePath) {
    err(
      "用法: tsx src/cli/vlog-transcribe.ts <audioOrVideoPath> [--model large-v3-turbo] [--language auto|zh|en] [--word-timestamps] [--timeout-ms 300000]",
    );
    process.exit(1);
  }
  err(`[vlog-transcribe] start: ${args.filePath}`);
  const result = await transcribeFile(args.filePath, {
    model: args.model,
    language: args.language,
    wordTimestamps: args.wordTimestamps,
    timeoutMs: args.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});
