/**
 * 单测：lib/wallpaper/video.ts — spawnHoneydoVideo + preprocessHeroFrame（任务 2）
 *
 * 契约（state.md ## 契约规约 计算/spawn 契约）：
 *   spawnHoneydoVideo({cliPath, prompt, firstFrame, lastFrame, outPath, seconds, res, timeoutMs})
 *     → {outPath: string, duration: number, stdout: string}
 *   错误枚举 HoneydoSpawnError（非零退出 / JSON 解析失败 / 产物文件不存在 / 超时 abort，
 *     message 含 stdout tail ≤2000 字符与超时毫秒数）
 *
 * 测试策略（照 video-claude-runner 惯例）：spawn stub 用真实 fake shell 脚本，
 * 不 mock child_process——更黑盒、更接近真实 spawn 路径。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HoneydoSpawnError, preprocessHeroFrame, spawnHoneydoVideo } from "../lib/wallpaper/video";

const tmpDir = path.join(os.tmpdir(), `wv-spawn-test-${process.pid}`);

/** 构造 fake honeydo 脚本：把收到的参数写到 $WV_CAPTURE，再按脚本模板行为行事 */
function makeFakeHoneydo(body: string): string {
  const p = path.join(tmpDir, `honeydo-${Math.random().toString(36).slice(2, 8)}.sh`);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "$WV_CAPTURE"\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

/** 从捕获文件读参数数组 */
function readCapture(capturePath: string): string[] {
  return execFileSync("cat", [capturePath], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("spawnHoneydoVideo", () => {
  let capturePath: string;
  const savedWvCapture = process.env.WV_CAPTURE;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    capturePath = path.join(tmpDir, "capture.txt");
    // fake honeydo 脚本经继承 env 拿到捕获文件路径
    process.env.WV_CAPTURE = capturePath;
  });

  afterAll(() => {
    if (savedWvCapture === undefined) {
      // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
      delete process.env.WV_CAPTURE;
    } else {
      process.env.WV_CAPTURE = savedWvCapture;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseOpts = {
    prompt: "画面中的景物以极缓慢的速度轻微摇曳",
    firstFrame: "/tmp/first.png",
    lastFrame: "/tmp/last.png",
    outPath: path.join(tmpDir, "out.mp4"),
    seconds: 15,
    res: "720p",
    timeoutMs: 10_000,
  };

  it("成功：参数拼装（prompt/-o/-r/--seconds/--first-frame/--last-frame）+ JSON 解析返回 outPath/duration", async () => {
    const script = makeFakeHoneydo(`
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
touch "$out"
echo "{\\"out\\":\\"$out\\",\\"duration\\":15,\\"res\\":\\"720p\\"}"
`);
    const res = await spawnHoneydoVideo({ ...baseOpts, cliPath: script });
    expect(res.outPath).toBe(baseOpts.outPath);
    expect(res.duration).toBe(15);
    expect(res.stdout).toContain("out");

    const args = readCapture(capturePath);
    expect(args[0]).toBe("video");
    expect(args[1]).toBe("gen");
    expect(args).toContain(baseOpts.prompt);
    expect(args).toContain("-o");
    expect(args[args.indexOf("-o") + 1]).toBe(baseOpts.outPath);
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("720p");
    expect(args).toContain("--seconds");
    expect(args[args.indexOf("--seconds") + 1]).toBe("15");
    expect(args).toContain("--first-frame");
    expect(args[args.indexOf("--first-frame") + 1]).toBe(baseOpts.firstFrame);
    expect(args).toContain("--last-frame");
    expect(args[args.indexOf("--last-frame") + 1]).toBe(baseOpts.lastFrame);
  });

  it("非零退出 → HoneydoSpawnError，message 含 stdout tail", async () => {
    const script = makeFakeHoneydo(`echo "boom-happened"\nexit 2\n`);
    await expect(spawnHoneydoVideo({ ...baseOpts, cliPath: script })).rejects.toBeInstanceOf(
      HoneydoSpawnError,
    );
    const err = await spawnHoneydoVideo({ ...baseOpts, cliPath: script }).catch((e) => e);
    expect(err.message).toContain("boom-happened");
  });

  it("JSON 解析失败 → HoneydoSpawnError", async () => {
    const script = makeFakeHoneydo(`echo "not-json-at-all"\nexit 0\n`);
    const err = await spawnHoneydoVideo({ ...baseOpts, cliPath: script }).catch((e) => e);
    expect(err).toBeInstanceOf(HoneydoSpawnError);
    expect(err.message).toContain("not-json-at-all");
  });

  it("产物文件不存在 → HoneydoSpawnError", async () => {
    // 回 JSON 但不 touch 产物
    const script = makeFakeHoneydo(
      `echo '{"out":"/tmp/wv-nonexistent-product.mp4","duration":15,"res":"720p"}'`,
    );
    const err = await spawnHoneydoVideo({ ...baseOpts, cliPath: script }).catch((e) => e);
    expect(err).toBeInstanceOf(HoneydoSpawnError);
  });

  it("超时 abort → HoneydoSpawnError，message 含超时毫秒数与 stdout tail（tail ≤2000 字符）", async () => {
    // 纯 sh builtin 前台循环写 5000 个 A（无 seq 子进程，sh 一起来毫秒级产出），
    // 然后 exec sleep 30：sh 被 sleep 替换，SIGTERM 直接杀掉且无子进程持有 stdio 管道。
    // 窗口给 2000ms：冷启动（vitest 首次 fork /bin/sh）实测可 >300ms，紧窗会 flake
    // （SIGTERM 落地时子进程尚未产出任何 stdout，tail 断言落空）。
    const script = makeFakeHoneydo(
      `i=0\nwhile [ $i -lt 500 ]; do printf 'AAAAAAAAAA'; i=$((i+1)); done; echo\nexec sleep 30\n`,
    );
    const err = await spawnHoneydoVideo({ ...baseOpts, cliPath: script, timeoutMs: 2000 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(HoneydoSpawnError);
    expect(err.message).toContain("2000ms");
    // stdout tail ≤2000 字符：5000 个 A 被截断
    expect(err.message.length).toBeLessThan(2600);
    expect(err.message).toContain("A");
  });
});

describe("preprocessHeroFrame", () => {
  const dir = path.join(os.tmpdir(), `wv-frame-test-${process.pid}`);

  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("横版：400×300 源图 cover 裁剪到 1280×704", async () => {
    const src = path.join(dir, "landscape-src.png");
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#2288cc" },
    })
      .png()
      .toFile(src);
    const out = await preprocessHeroFrame(src, 1280, 704);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(704);
    expect(meta.format).toBe("png");
  });

  it("竖版：300×400 源图 cover 裁剪到 704×1216", async () => {
    const src = path.join(dir, "portrait-src.png");
    await sharp({
      create: { width: 300, height: 400, channels: 3, background: "#cc2288" },
    })
      .png()
      .toFile(src);
    const out = await preprocessHeroFrame(src, 704, 1216);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(704);
    expect(meta.height).toBe(1216);
  });

  // ---- v2 增量任务 12：人脸构图裁剪 ----

  /** 源图底色 bg，在 (fx,fy) 画 faceW×faceH 红色方块（模拟人脸），返回路径 */
  async function makeSource(
    name: string,
    width: number,
    height: number,
    bg: string,
    fx: number,
    fy: number,
    faceW: number,
    faceH: number,
  ): Promise<string> {
    const src = path.join(dir, name);
    const square = await sharp({
      create: { width: faceW, height: faceH, channels: 3, background: "#cc2222" },
    })
      .png()
      .toBuffer();
    await sharp({
      create: { width, height, channels: 3, background: bg },
    })
      .composite([{ input: square, left: fx, top: fy }])
      .png()
      .toFile(src);
    return src;
  }

  /** 取输出 png 指定坐标像素（r,g,b） */
  async function pixelAt(
    pngPath: string,
    x: number,
    y: number,
  ): Promise<{ r: number; g: number; b: number }> {
    const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
    const idx = (y * info.width + x) * info.channels;
    return { r: data[idx] as number, g: data[idx + 1] as number, b: data[idx + 2] as number };
  }

  function isRed(p: { r: number; g: number; b: number }): boolean {
    return p.r > 150 && p.g < 90 && p.b < 90;
  }

  it("人脸构图：小脸靠左上 → 窗口缩放至脸高≈画布高 1/4 且中心对齐人脸", async () => {
    // 4000×3000 源，脸 300×300 @(200,200)：推导窗口 winH=1200（=4×脸高，脸高映射恰 704/4=176）
    // 窗口 2182×1200 中心对齐脸心 (350,350) → clamp 到 (0,0)
    const src = await makeSource("face-small-tl.png", 4000, 3000, "#2288cc", 200, 200, 300, 300);
    const out = await preprocessHeroFrame(src, 1280, 704, {
      faceBbox: { x: 200, y: 200, w: 300, h: 300 },
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(704);
    // 脸方块落在窗口 (0,0,2182,1200) 内 (200..500,200..500) → 画布缩放 0.5866 → (117..293)
    expect(isRed(await pixelAt(out, 200, 200))).toBe(true);
    expect(isRed(await pixelAt(out, 640, 352))).toBe(false);
  });

  it("人脸构图：脸在整图已 ≥1/4 → 全幅窗口按脸心取位（不放大）", async () => {
    // 2000×1000 源，脸 300×300 @(1500,400)：脸高占全幅 30% → 窗口=全幅 cover（winH=1000）
    // winW=1818，脸心 1650 超右界 → 窗口右对齐；脸在画布右半
    const src = await makeSource("face-big-right.png", 2000, 1000, "#2288cc", 1500, 400, 300, 300);
    const out = await preprocessHeroFrame(src, 1280, 704, {
      faceBbox: { x: 1500, y: 400, w: 300, h: 300 },
    });
    // 脸方块画布区域约 (928..1139, 282..493)
    expect(isRed(await pixelAt(out, 1030, 387))).toBe(true);
    expect(isRed(await pixelAt(out, 300, 387))).toBe(false);
  });

  it("人脸构图：竖版画布 704×1216 同样生效（脸高 ≥1216/4=304）", async () => {
    // 3000×4000 源，脸 400×400 @(200,200)：winH=min(max(min(4032? no: fullH=min(4000,3000/0.579)=4000? → capped=min(4000,1600)=1600; minWin=min(1216,4000)=1216 → winH=1600
    // 窗口 1600×1600? winW=1600*0.579=927 → 中心 (400,400) → left/top=0
    const src = await makeSource("face-portrait.png", 3000, 4000, "#2288cc", 200, 200, 400, 400);
    const out = await preprocessHeroFrame(src, 704, 1216, {
      faceBbox: { x: 200, y: 200, w: 400, h: 400 },
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(704);
    expect(meta.height).toBe(1216);
    // 脸方块在窗口 (0,0,927,1600) 内 (200..600,200..600) → 缩放 1216/1600=0.76 → (152..456,152..456)
    expect(isRed(await pixelAt(out, 300, 300))).toBe(true);
    expect(isRed(await pixelAt(out, 352, 900))).toBe(false);
  });

  it("faceBbox 缺省/退化 → 回退中心构图（现状行为）", async () => {
    const src = await makeSource("face-degenerate.png", 4000, 3000, "#2288cc", 200, 200, 300, 300);
    // 缺省
    const out1 = await preprocessHeroFrame(src, 1280, 704);
    const meta1 = await sharp(out1).metadata();
    expect(meta1.width).toBe(1280);
    expect(meta1.height).toBe(704);
    // 退化 bbox（w=0）→ 同样走中心构图（脸不被拉近中心：画布中心为底色）
    const out2 = await preprocessHeroFrame(src, 1280, 704, {
      faceBbox: { x: 200, y: 200, w: 0, h: 300 },
    });
    const meta2 = await sharp(out2).metadata();
    expect(meta2.width).toBe(1280);
    expect(meta2.height).toBe(704);
    expect(isRed(await pixelAt(out2, 640, 352))).toBe(false);
  });
});
