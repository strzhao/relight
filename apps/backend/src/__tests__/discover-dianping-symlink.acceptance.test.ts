import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkPhotoToDir } from "../cli/dianping-output";

/**
 * linkPhotoToDir 真实文件系统集成测试。
 * 临时目录用 os.homedir + mkdtemp（避开 /tmp，遵循 backfill-thumbnails 的 CI Linux 教训）。
 */
describe("dianping linkPhotoToDir · symlink 集成", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.homedir(), ".relight-dianping-link-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("link 真实文件 → 产出相对路径 symlink，解析到源", async () => {
    const srcDir = path.join(tmpRoot, "src");
    await mkdir(srcDir, { recursive: true });
    const src = path.join(srcDir, "IMG_001.jpg");
    await writeFile(src, "fake-jpeg");

    const out = await linkPhotoToDir(src, path.join(tmpRoot, "out"), "photo-001");

    expect(out).toBe(path.join(tmpRoot, "out", "IMG_001.jpg"));
    expect((await lstat(out)).isSymbolicLink()).toBe(true);
    const target = await readlink(out);
    expect(target.startsWith("..")).toBe(true); // 相对路径，不以 / 开头
    expect(await realpath(out)).toBe(await realpath(src)); // 解析回源
  });

  it("HEIC 文件保留 .HEIC 扩展名（不转 jpg）", async () => {
    const srcDir = path.join(tmpRoot, "src");
    await mkdir(srcDir, { recursive: true });
    const src = path.join(srcDir, "IMG_002.HEIC");
    await writeFile(src, "fake-heic");

    const out = await linkPhotoToDir(src, path.join(tmpRoot, "out"), "photo-002");
    expect(out).toBe(path.join(tmpRoot, "out", "IMG_002.HEIC")); // 不产生双扩展名 IMG_002.HEIC.heic
    expect(path.extname(out).toLowerCase()).toBe(".heic");
    expect(out).not.toMatch(/\.jpg$/i);
  });

  it("幂等：重复 link 同源同目录 → 返回同路径，不报错", async () => {
    const srcDir = path.join(tmpRoot, "src");
    await mkdir(srcDir, { recursive: true });
    const src = path.join(srcDir, "IMG_003.png");
    await writeFile(src, "fake-png");
    const outDir = path.join(tmpRoot, "out");

    const out1 = await linkPhotoToDir(src, outDir, "photo-003");
    const out2 = await linkPhotoToDir(src, outDir, "photo-003");
    expect(out1).toBe(out2);
    expect((await lstat(out1)).isSymbolicLink()).toBe(true);
  });

  it("中间 symlink 规范化：src 经中间 symlink → target 指向 real 路径", async () => {
    // 模拟 nas-photos → /Volumes/... 的中间 symlink 场景
    const realDir = path.join(tmpRoot, "real-backup");
    const linkDir = path.join(tmpRoot, "nas-photos");
    const outDir = path.join(tmpRoot, "dianping", "2026-06-14_午餐_杭州");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    const realFile = path.join(realDir, "IMG_004.jpg");
    await writeFile(realFile, "x");
    const srcThroughLink = path.join(linkDir, "IMG_004.jpg"); // 经过中间 symlink

    const out = await linkPhotoToDir(srcThroughLink, outDir, "photo-004");
    const target = await readlink(out);
    expect(target).toContain("real-backup");
    expect(target).not.toContain("nas-photos"); // 已 realpath 规范掉中间 symlink
  });

  it("同名冲突（不同源同 baseName）→ 第二个追加 id 后缀，各自指向各自源", async () => {
    const srcDir1 = path.join(tmpRoot, "a");
    const srcDir2 = path.join(tmpRoot, "b");
    await mkdir(srcDir1, { recursive: true });
    await mkdir(srcDir2, { recursive: true });
    const s1 = path.join(srcDir1, "DUP.jpg");
    const s2 = path.join(srcDir2, "DUP.jpg");
    await writeFile(s1, "1");
    await writeFile(s2, "2");
    const outDir = path.join(tmpRoot, "out");

    const out1 = await linkPhotoToDir(s1, outDir, "11111111");
    const out2 = await linkPhotoToDir(s2, outDir, "22222222");

    expect(out1).toBe(path.join(outDir, "DUP.jpg"));
    expect(out2).toBe(path.join(outDir, "DUP_222222.jpg")); // slice(0,6)="222222"
    expect(await realpath(out1)).toBe(await realpath(s1));
    expect(await realpath(out2)).toBe(await realpath(s2));
  });

  it("源不存在 → realpath 抛错透传（调用方计 failed，不静默吞）", async () => {
    await expect(
      linkPhotoToDir(path.join(tmpRoot, "nope.jpg"), path.join(tmpRoot, "out"), "x"),
    ).rejects.toThrow();
  });
});
