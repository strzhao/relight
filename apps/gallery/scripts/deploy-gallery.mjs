#!/usr/bin/env node
/**
 * 画廊部署脚本（state.md §工程与部署 / 阶段 3）
 *
 * scp 三件套（index.html / app.css / app.js）+ fonts/ 到 VPS `/home/ubuntu/relight-gallery/`。
 *
 * 凭据来源（与 apps/backend/src/lib/config.ts 的 config.gallery 完全一致 env 解析）：
 *   GALLERY_VPS_HOST  默认 43.143.124.222
 *   GALLERY_VPS_USER  默认 ubuntu
 *   GALLERY_VPS_KEY   必填（SSH 私钥路径）
 *   GALLERY_VPS_PATH  默认 /home/ubuntu/relight-gallery
 *
 * 用法：
 *   pnpm deploy:gallery
 *
 * 终结手动部署：每次 gallery 三件套/字体改动后跑一次即可。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// gallery 目录（scripts/ 的上级，即 apps/gallery）
const galleryDir = resolve(__dirname, "..");

// 凭据（与 backend config.gallery 同源 env）
const vpsHost = process.env.GALLERY_VPS_HOST ?? "43.143.124.222";
const vpsUser = process.env.GALLERY_VPS_USER ?? "ubuntu";
const vpsKey = process.env.GALLERY_VPS_KEY ?? "";
const vpsPath = process.env.GALLERY_VPS_PATH ?? "/home/ubuntu/relight-gallery";

if (!vpsKey) {
  console.error("[deploy:gallery] GALLERY_VPS_KEY 未配置（SSH 私钥路径）。请设置后重试。");
  process.exit(1);
}

// 校验三件套存在
const assets = ["index.html", "app.css", "app.js"];
for (const f of assets) {
  if (!existsSync(resolve(galleryDir, f))) {
    console.error(`[deploy:gallery] 缺失文件: ${f}`);
    process.exit(1);
  }
}
if (!existsSync(resolve(galleryDir, "fonts"))) {
  console.error("[deploy:gallery] 缺失 fonts/ 目录");
  process.exit(1);
}

const sshBase = [
  "-i",
  vpsKey,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
];
const target = `${vpsUser}@${vpsHost}:${vpsPath}/`;

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", timeout: 60_000 });
}

/** 单引号转义（防 ssh 远程命令注入，与 sync.ts pushManifest 同源硬化） */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

console.log(`[deploy:gallery] 部署到 ${target}`);

// 1. 确保远程目录存在（vpsPath shellQuote 防注入，与 sync.ts 同源硬化）
const remoteFontsDir = shellQuote(`${vpsPath}/fonts`);
run("ssh", [...sshBase, `${vpsUser}@${vpsHost}`, `mkdir -p ${remoteFontsDir}`]);

// 2. scp 三件套
run("scp", [...sshBase, ...assets.map((f) => resolve(galleryDir, f)), target]);

// 3. scp 字体
run("scp", [...sshBase, "-r", resolve(galleryDir, "fonts"), target]);

console.log(`[deploy:gallery] ✅ 部署完成 → ${target}`);
console.log("           访问 https://gallery.stringzhao.life 验证（Caddy 静态托管）");
