#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Next.js dev server 在加载 .env.local 之前就读取 PORT，所以 .env.local 里的 PORT 不能改 dev 端口。
// 这个包装脚本先解析 .env / .env.local 注入到子进程 env，再 spawn next dev/start，让 PORT 生效。

const env = { ...process.env };
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  const content = readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: run-with-env.mjs <cmd> [args...]\n");
  process.exit(1);
}

const child = spawn(args[0], args.slice(1), { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
