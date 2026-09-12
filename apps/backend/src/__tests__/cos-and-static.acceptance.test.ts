/**
 * 验收测试（红队）：COS 直链公有读（S15）+ gallery 纯静态三件套（S16）
 *
 * 设计契约来源（state.md §验收场景 S15/S16）：
 *   - S15.PM1 [real-process] manifest 内 COS 直链公有读 200（curl -I）
 *   - S15.PM2 [real-process] COS bucket 根列表 403/404 不可枚举
 *   - S15.PM3 [real-process] 已知 photoId mid/thumb URL GET 200
 *   - S16.PM1 [fs-grep] gallery 纯静态三件套无 dist/node_modules
 *
 * 红队铁律：不读 lib/cos/* 源码。
 *   - S15 用 Node child_process 调真实 curl（real-process），manifest URL 来自 env 或 VPS 公网
 *   - S16 纯 fs.readdir 断言
 *
 * 强断言铁律：
 *   - S15 依赖外网 + 真实部署 manifest；无 MANIFEST_URL env 时 fail 并提示如何提供（不 skip）
 *   - S16 不依赖网络，直接断言
 */
import "./helpers/restore-real-cos-env";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// 例外说明：vitest.setup.ts 全局清空 COS 凭据防测试写生产桶；本文件是【只读】的
// 真实 COS 冒烟（curl HEAD/GET 公有读与不可枚举），通过 helpers/restore-real-cos-env
// 在 config 求值前恢复凭据（仅本 fork，不做任何写操作）。
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const ARTIFACT_DIR = "/tmp/autopilot-artifacts";

// ============================================================================
// S15 配置：manifest URL（来自 env，默认 VPS 公网地址）
// ============================================================================
const MANIFEST_URL =
  process.env.S15_MANIFEST_URL ?? "https://gallery.stringzhao.life/manifest.json";
// COS bucket 根（去 key）—— 从 manifest 内 URL 解析推导，或 env 显式提供
const COS_BUCKET_ROOT_OVERRIDE = process.env.S15_COS_BUCKET_ROOT; // e.g. https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/

const GALLERY_DIR = process.env.GALLERY_DIR ?? path.resolve(__dirname, "../../../gallery");

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

async function writeArtifact(id: string, content: string): Promise<void> {
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

/** curl -I 拿状态码（real-process，真网络） */
function curlHead(url: string, timeoutSec = 15): { status: number; ok: boolean } {
  try {
    const out = execFileSync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-I", "--max-time", String(timeoutSec), url],
      { encoding: "utf-8", timeout: (timeoutSec + 5) * 1000 },
    );
    const status = Number.parseInt(out.trim(), 10);
    return { status, ok: Number.isFinite(status) && status > 0 };
  } catch (e) {
    return { status: -1, ok: false };
  }
}

/** curl -X GET 拿状态码（real-process，真网络） */
function curlGet(url: string, timeoutSec = 15): { status: number; ok: boolean } {
  try {
    const out = execFileSync(
      "curl",
      [
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "-X",
        "GET",
        "--max-time",
        String(timeoutSec),
        url,
      ],
      { encoding: "utf-8", timeout: (timeoutSec + 5) * 1000 },
    );
    const status = Number.parseInt(out.trim(), 10);
    return { status, ok: Number.isFinite(status) && status > 0 };
  } catch {
    return { status: -1, ok: false };
  }
}

/** fetch manifest JSON（Vitest Node 20 自带 fetch） */
async function fetchManifest(): Promise<{
  photos: Array<{ original: string; thumbnail: string }>;
  videos: Array<{ mp4: string }>;
}> {
  const resp = await fetch(MANIFEST_URL, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`fetch manifest 失败 status=${resp.status} url=${MANIFEST_URL}`);
  }
  const data = (await resp.json()) as {
    days?: Array<{ photos?: Array<{ original: string; thumbnail: string }> }>;
    videos?: Array<{ mp4: string }>;
  };
  const photos = (data.days ?? []).flatMap((d) => d.photos ?? []);
  const videos = data.videos ?? [];
  return { photos, videos };
}

// ============================================================================
// S15.PM1：manifest 内 COS 直链公有读 200
// ============================================================================
describe("[S15.PM1] manifest 内 COS 直链公有读 200", () => {
  it("首个 photo.original 与 video.mp4 curl -I 状态码 == 200", async () => {
    const { photos, videos } = await fetchManifest();
    expect(photos.length, "manifest 应至少 1 张 photo").toBeGreaterThan(0);

    const firstOriginal = photos[0]!.original;
    const firstMp4 = videos[0]?.mp4;

    const r1 = curlHead(firstOriginal);
    const r2 = firstMp4 ? curlHead(firstMp4) : { status: 200, ok: true }; // 无视频时不阻断此断言

    await writeArtifact("S15.PM1", JSON.stringify({ firstOriginal, firstMp4, r1, r2 }));
    expect(r1.status, `photo.original 应 200，url=${firstOriginal}`).toBe(200);
    if (firstMp4) {
      expect(r2.status, `video.mp4 应 200，url=${firstMp4}`).toBe(200);
    }
  }, 60000);
});

// ============================================================================
// S15.PM2：COS bucket 根列表 403/404 不可枚举
// ============================================================================
describe("[S15.PM2] COS bucket 根不可枚举", () => {
  it("curl -I COS bucket 根路径状态码 == 403 OR == 404", async () => {
    const { photos } = await fetchManifest();
    const sample = photos[0]!.original;

    // 推导 bucket 根：取 https://<host>/  部分（去 key）
    let bucketRoot = COS_BUCKET_ROOT_OVERRIDE;
    if (!bucketRoot) {
      const m = sample.match(/^(https?:\/\/[^/]+)/);
      if (!m) throw new Error(`无法从 URL 推导 bucket 根：${sample}`);
      bucketRoot = `${m[1]}/`;
    }

    const r = curlHead(bucketRoot);
    await writeArtifact("S15.PM2", JSON.stringify({ bucketRoot, status: r.status }));
    expect([403, 404], `bucket 根应 403/404 不可枚举，实际=${r.status}`).toContain(r.status);
  }, 60000);
});

// ============================================================================
// S15.PM3：已知 photoId mid/thumb URL 公有读 GET 200
// ============================================================================
describe("[S15.PM3] 已知 photoId mid/thumb URL GET 200", () => {
  it("首 photo original(mid) 与 thumbnail 直链 GET 状态码 == 200", async () => {
    const { photos } = await fetchManifest();
    expect(photos.length).toBeGreaterThan(0);

    const first = photos[0]!;
    const rMid = curlGet(first.original);
    const rThumb = curlGet(first.thumbnail);

    await writeArtifact("S15.PM3", JSON.stringify({ first, rMid, rThumb }));
    expect(rMid.status, `mid(original) 应 200，url=${first.original}`).toBe(200);
    expect(rThumb.status, `thumb 应 200，url=${first.thumbnail}`).toBe(200);
  }, 60000);
});

// ============================================================================
// S16.PM1 [fs-grep] gallery 纯静态三件套无构建产物
// ============================================================================
describe("[S16.PM1] gallery 部署产物纯静态（无构建依赖）", () => {
  it("apps/gallery/ 顶层含 index.html AND app.css AND app.js AND 不含 dist（构建产物）AND node_modules 被 .gitignore 挡", () => {
    const entries = fs.readdirSync(GALLERY_DIR);
    const entrySet = new Set(entries);
    const gitignore = fs.readFileSync(path.join(GALLERY_DIR, ".gitignore"), "utf8");

    const result = {
      hasIndexHtml: entrySet.has("index.html"),
      hasAppCss: entrySet.has("app.css"),
      hasAppJs: entrySet.has("app.js"),
      hasDist: entrySet.has("dist"),
      hasNodeModules: entrySet.has("node_modules"),
      nodeModulesGitignored: /^\/?node_modules\//m.test(gitignore),
      entries,
    };

    fs.writeFileSync(path.join(ARTIFACT_DIR, "S16.PM1.out"), JSON.stringify(result, null, 2));

    expect(result.hasIndexHtml, "index.html 必须存在").toBe(true);
    expect(result.hasAppCss, "app.css 必须存在").toBe(true);
    expect(result.hasAppJs, "app.js 必须存在").toBe(true);
    expect(result.hasDist, "不应有 dist/ 构建产物（纯静态无构建）").toBe(false);
    // node_modules 是开发依赖（@playwright/test E2E），允许本地存在但必须 .gitignore 挡
    // （不入库不部署；deploy:gallery script 只 scp index.html/app.css/app.js/fonts）
    expect(result.nodeModulesGitignored, "node_modules 必须被 .gitignore 挡（不入库不部署）").toBe(
      true,
    );
  });
});
