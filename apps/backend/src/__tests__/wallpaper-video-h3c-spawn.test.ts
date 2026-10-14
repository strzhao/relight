/**
 * 单测：lib/wallpaper/video.ts — spawnH3cVideo（20261014 h3.c 引擎接入）
 *
 * 契约：
 *   spawnH3cVideo({binPath, modelDir, prompt, firstFrame, lastFrame, outPath, seconds,
 *     width, height, timeoutMs?, steps?, layers?, reuse?, seed?, ssdStreaming?})
 *     → {outPath: string, stdout: string}
 *   argv 组装：-d MODEL_DIR -p PROMPT --first-frame FF --last-frame LF -o OUT
 *     --width W --height H --seconds S --steps --layers --reuse --seed [--ssd-streaming]
 *   成功判据 = 退出码 0 ∧ 产物文件存在（无 stdout JSON 回执；spawn 前 pre-delete 产物）
 *   错误枚举 H3cSpawnError（非零退出 / 产物缺失 / 超时 abort，message 含 stderr/stdout tail
 *     与超时毫秒数）
 *   默认档 = A/B 验证档：steps 20 / layers 45 / reuse 2 / seed 42 / ssd-streaming on
 *
 * 测试策略（照 wallpaper-video-spawn.test.ts 惯例）：spawn stub 用真实 fake shell 脚本，
 * 不 mock child_process——更黑盒、更接近真实 spawn 路径。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { H3cSpawnError, spawnH3cVideo } from "../lib/wallpaper/video";

const tmpDir = path.join(os.tmpdir(), `wv-h3c-spawn-test-${process.pid}`);

/** 构造 fake h3 脚本：把收到的参数写到 $H3C_CAPTURE，再按脚本模板行为行事 */
function makeFakeH3(body: string): string {
  const p = path.join(tmpDir, `h3-${Math.random().toString(36).slice(2, 8)}.sh`);
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$@" > "$H3C_CAPTURE"\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

/** 从捕获文件读参数数组 */
function readCapture(capturePath: string): string[] {
  return execFileSync("cat", [capturePath], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("spawnH3cVideo", () => {
  let capturePath: string;
  const savedCapture = process.env.H3C_CAPTURE;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    capturePath = path.join(tmpDir, "capture.txt");
    // fake h3 脚本经继承 env 拿到捕获文件路径
    process.env.H3C_CAPTURE = capturePath;
  });

  afterAll(() => {
    if (savedCapture === undefined) {
      // biome-ignore lint/performance/noDelete: process.env 必须用 delete 取消设置
      delete process.env.H3C_CAPTURE;
    } else {
      process.env.H3C_CAPTURE = savedCapture;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseOpts = {
    binPath: "/tmp/fake-h3",
    modelDir: "/Users/stringzhao/ml/h3-models",
    prompt: "男孩把举过头顶的斗笠轻轻扣下戴在头上。Audio: soft outdoor ambience, no talking",
    firstFrame: "/tmp/first.png",
    lastFrame: "/tmp/last.png",
    outPath: path.join(tmpDir, "out.mp4"),
    seconds: 4,
    width: 992,
    height: 992,
    timeoutMs: 10_000,
  };

  it("成功：argv 组装（-d/-p/--first-frame/--last-frame/-o/--width/--height/--seconds）+ A/B 默认档参数 + 返回 outPath", async () => {
    const script = makeFakeH3(`
pwd > "$H3C_CAPTURE.cwd"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
touch "$out"
echo "rendering... done"
`);
    const res = await spawnH3cVideo({ ...baseOpts, binPath: script });
    expect(res.outPath).toBe(baseOpts.outPath);
    expect(res.stdout).toContain("rendering");

    // cwd 必须固定到 bin 同目录（h3 以 CWD 相对路径加载 h3_shaders.metal）；
    // pwd 输出真实路径（/private/var…），tmpdir 是符号链接，须 realpath 后比较
    const cwd = execFileSync("cat", [`${capturePath}.cwd`], { encoding: "utf8" }).trim();
    expect(cwd).toBe(realpathSync(path.dirname(script)));

    const args = readCapture(capturePath);
    expect(args[args.indexOf("-d") + 1]).toBe(baseOpts.modelDir);
    expect(args).toContain(baseOpts.prompt);
    expect(args[args.indexOf("--first-frame") + 1]).toBe(baseOpts.firstFrame);
    expect(args[args.indexOf("--last-frame") + 1]).toBe(baseOpts.lastFrame);
    expect(args[args.indexOf("-o") + 1]).toBe(baseOpts.outPath);
    expect(args[args.indexOf("--width") + 1]).toBe("992");
    expect(args[args.indexOf("--height") + 1]).toBe("992");
    expect(args[args.indexOf("--seconds") + 1]).toBe("4");
    // A/B 验证档默认参数（未传 opts 时逐字锁定）
    expect(args[args.indexOf("--steps") + 1]).toBe("20");
    expect(args[args.indexOf("--layers") + 1]).toBe("45");
    expect(args[args.indexOf("--reuse") + 1]).toBe("2");
    expect(args[args.indexOf("--seed") + 1]).toBe("42");
    expect(args).toContain("--ssd-streaming");
  });

  it("opts 覆盖 steps/layers/reuse/seed/ssdStreaming=false → argv 逐字跟随（ssd 关时无该 flag）", async () => {
    const script = makeFakeH3(`
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
touch "$out"
`);
    await spawnH3cVideo({
      ...baseOpts,
      binPath: script,
      steps: 50,
      layers: 50,
      reuse: 1,
      seed: 7,
      ssdStreaming: false,
    });
    const args = readCapture(capturePath);
    expect(args[args.indexOf("--steps") + 1]).toBe("50");
    expect(args[args.indexOf("--layers") + 1]).toBe("50");
    expect(args[args.indexOf("--reuse") + 1]).toBe("1");
    expect(args[args.indexOf("--seed") + 1]).toBe("7");
    expect(args).not.toContain("--ssd-streaming");
  });

  it("不传 lastFrame → argv 不含 --last-frame（20261014 单锚定默认：双锚定钉死运动）", async () => {
    const script = makeFakeH3(`
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
touch "$out"
`);
    await spawnH3cVideo({ ...baseOpts, binPath: script, lastFrame: undefined });
    const args = readCapture(capturePath);
    expect(args).not.toContain("--last-frame");
    expect(args).toContain("--first-frame");
  });

  it("spawn 前 pre-delete 产物：退出 0 但未写产物时，陈旧文件不构成误判成功", async () => {
    // 预埋陈旧产物 → fake h3 退出 0 且不 touch。若实现无 pre-delete，access(陈旧文件)
    // 会命中 → 误判成功；pre-delete 后必须报「产物文件不存在」。
    const stalePath = path.join(tmpDir, "stale-out.mp4");
    writeFileSync(stalePath, "stale");
    const script = makeFakeH3(`echo "done-nothing"\nexit 0\n`);
    const err = await spawnH3cVideo({
      ...baseOpts,
      binPath: script,
      outPath: stalePath,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(H3cSpawnError);
    expect(err.message).toContain("产物文件不存在");
  });

  it("非零退出 → H3cSpawnError，message 含退出码与 stdout tail", async () => {
    const script = makeFakeH3(`echo "oops"\nexit 1\n`);
    const err = await spawnH3cVideo({
      ...baseOpts,
      binPath: script,
      outPath: path.join(tmpDir, "never-written-2.mp4"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(H3cSpawnError);
    expect(err.message).toContain("退出码 1");
    expect(err.message).toContain("oops");
  });

  it("退出 0 但产物不存在（未 touch 且无陈旧文件）→ H3cSpawnError", async () => {
    const script = makeFakeH3(`echo "done-but-no-file"\nexit 0\n`);
    const err = await spawnH3cVideo({
      ...baseOpts,
      binPath: script,
      outPath: path.join(tmpDir, "never-written.mp4"),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(H3cSpawnError);
    expect(err.message).toContain("产物文件不存在");
  });

  it("超时 abort → H3cSpawnError，message 含超时毫秒数（tail 截断 ≤2600 字符级）", async () => {
    // 与 wallpaper-video-spawn.test.ts 同款：sh builtin 产出后 exec sleep 挂住
    const script = makeFakeH3(
      `i=0\nwhile [ $i -lt 500 ]; do printf 'BBBBBBBBBB'; i=$((i+1)); done; echo\nexec sleep 30\n`,
    );
    const timeoutMs = 5000;
    const err = await spawnH3cVideo({ ...baseOpts, binPath: script, timeoutMs }).catch((e) => e);
    expect(err).toBeInstanceOf(H3cSpawnError);
    expect(err.message).toContain(`${timeoutMs}ms`);
    expect(err.message).toContain("B");
  });
});
