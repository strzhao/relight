/**
 * 单元测试：readOrientedDimensions 的 EXIF orientation 宽高互换。
 *
 * 背景（QA 审查 Important 缺口）：iPhone 竖拍（orientation 5-8）是照片库主场景，
 * 画布朝向判定（computeNativeCanvas 的 landscape 分支）与预裁剪都吃这个函数的输出——
 * 若互换逻辑回归会静默产出横版画布。此前全部 job/acceptance 测试 mock 该函数，零直测。
 *
 * 真实 sharp + 真实 JPEG orientation 标签（像素不旋转、仅元数据），无任何 mock。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpRoot = "";

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.homedir(), ".relight-test-orient-"));
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readOrientedDimensions：EXIF orientation 5-8 宽高互换（iPhone 竖拍主场景）", () => {
  it("orientation=6（90° CW 旋转）→ 300×200 像素报为 200×300", async () => {
    const p = path.join(tmpRoot, "orient6.jpg");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#2288cc" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(p);
    const meta = await sharp(p).metadata();
    expect(meta.orientation, "fixture 必须带 orientation=6").toBe(6);

    const { readOrientedDimensions } = await import("../lib/wallpaper/video");
    expect(await readOrientedDimensions(p)).toEqual({ width: 200, height: 300 });
  });

  it("orientation=8（270°）→ 同样互换", async () => {
    const p = path.join(tmpRoot, "orient8.jpg");
    await sharp({ create: { width: 400, height: 100, channels: 3, background: "#22cc88" } })
      .withMetadata({ orientation: 8 })
      .jpeg()
      .toFile(p);

    const { readOrientedDimensions } = await import("../lib/wallpaper/video");
    expect(await readOrientedDimensions(p)).toEqual({ width: 100, height: 400 });
  });

  it("orientation=1（无旋转，横拍）→ 原样返回", async () => {
    const p = path.join(tmpRoot, "orient1.jpg");
    await sharp({ create: { width: 640, height: 480, channels: 3, background: "#cc8822" } })
      .withMetadata({ orientation: 1 })
      .jpeg()
      .toFile(p);

    const { readOrientedDimensions } = await import("../lib/wallpaper/video");
    expect(await readOrientedDimensions(p)).toEqual({ width: 640, height: 480 });
  });
});
