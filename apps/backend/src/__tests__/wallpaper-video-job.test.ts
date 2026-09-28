/**
 * 单测：wallpaper-video job 主流程（任务 4 + v2 增量任务 12/15；20260928 单腿原生比例改版）
 *
 * 契约（state.md ## 后端设计 4 / ## 契约规约；20260928 D2）：
 *   runWallpaperVideo(pickDate)：
 *     - 开关关 → log skip 返回（零 honeydo 调用）
 *     - 无记录 / hero.isVideo / composedImagePath null → skip
 *     - sharp 读 hero EXIF 旋转后尺寸 → computeNativeCanvas 单腿原生画布
 *     - faces 表取 hero 最大 bbox（仅 prompt 分层默认；预裁剪已无人脸窗口）
 *     - 单腿串接：spawn 生成（-r 720p + --width/--height 画布覆盖）→ buildLoop（palindrome）
 *       → renderTextOverlay（props 携画布宽高）→ 转码 A（画廊原生 mp4，分辨率==画布）
 *       → 尺寸护栏 → 转码 B（条件 Aerial：画布 w/h ∈ [1.5,1.9] 才产 16:9 微裁 .mov）
 *       → COS 上传（native key `_native.mp4` video/mp4；aerial key `_landscape.mov`
 *         video/quicktime），回执非空串才写 DB 列
 *     - syncDayToGallery 复用
 *   失败语义（契约 8）：任一环节 throw（含尺寸护栏）→ native/landscape 两列均空 → 静态回退
 *   返回 {native, landscape}
 *
 * 测试策略：mock ../db（真实 drizzle schema 列引用 + stub select/update）、
 * mock ../lib/wallpaper/video（fs/sharp/ffmpeg 边界：readOrientedDimensions /
 * assertVideoDimensions 一并 mock）、../lib/cos/upload、../lib/gallery/sync、../lib/config；
 * computeNativeCanvas 用真实纯函数（native-canvas.ts 无依赖）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- 状态容器（vi.mock factory 与测试体共享）----
const state = vi.hoisted(() => ({
  pickRows: [] as unknown[],
  photoRows: [] as unknown[],
  faceRows: [] as unknown[],
  updates: [] as { table: string; vals: Record<string, unknown> }[],
  pickTable: {} as object,
  photosTable: {} as object,
  facesTable: {} as object,
  calls: {
    dims: [] as string[],
    spawn: [] as Record<string, unknown>[],
    buildLoop: [] as { src: string; targetSeconds: number }[],
    renderTextOverlay: [] as { videoPath: string; meta: Record<string, unknown> }[],
    assertDims: [] as { filePath: string; w: number; h: number }[],
    transcodeAerialNative: [] as unknown[][],
    transcodeGallery: [] as unknown[][],
    upload: [] as { localPath: string; cosKey: string; contentType: string }[],
    syncDay: [] as unknown[],
    preprocess: [] as { photoPath: string; width: number; height: number }[],
  },
  uploadReturn: "" as string,
  /** sharp 读出的 hero 尺寸（mock readOrientedDimensions 返回值，按用例设置） */
  heroDims: { width: 4000, height: 3000 } as { width: number; height: number },
}));

vi.mock("../db", async () => {
  const actualSchema = (await vi.importActual("../db/schema")) as Record<string, unknown>;
  const schema = actualSchema; // schema.ts 顶层导出即各表对象
  state.pickTable = schema.dailyPicks as object;
  state.photosTable = schema.photos as object;
  state.facesTable = schema.faces as object;
  const rowsFor = (table: unknown) =>
    table === state.pickTable
      ? state.pickRows
      : table === state.photosTable
        ? state.photoRows
        : table === state.facesTable
          ? state.faceRows
          : [];
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => rowsFor(table),
            }),
            // dailyPicks/photos 查询无 orderBy（drizzle 允许链尾省略）——兜底直连 limit
            limit: async () => rowsFor(table),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            state.updates.push({ table: table === state.pickTable ? "dailyPicks" : "other", vals });
            return { run: async () => undefined };
          },
        }),
      }),
    },
    schema,
  };
});

vi.mock("../lib/config", () => ({
  config: {
    wallpaperVideoEnabled: true,
    wallpaperVideoSeconds: 4,
    wallpaperVideoLoopSeconds: 8,
    wallpaperVideoSpawnTimeoutMs: 5_400_000,
    honeydoCliPath: "/usr/local/bin/honeydo",
    storageRoot: "/tmp/wv-job-test-storage",
    wallpaperVideoPromptPerson:
      "人物保持自然状态，轻轻侧头微笑，发丝和衣角随风轻扬，手部小幅度轻柔互动，光影缓缓流动",
    wallpaperVideoPromptScene:
      "镜头极缓慢推近，光影柔和流动，云影水波轻轻变幻，花草树叶随风微动，画面宁静而生动",
    cos: {
      prefix: "relight",
      bucket: "b",
      region: "ap-shanghai",
      secretId: "id",
      secretKey: "key",
    },
    gallery: { vpsHost: "", vpsPath: "", vpsKey: "" },
  },
}));

vi.mock("../lib/wallpaper/video", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readOrientedDimensions: vi.fn(async (photoPath: string) => {
      state.calls.dims.push(photoPath);
      return state.heroDims;
    }),
    preprocessHeroFrame: vi.fn(async (photoPath: string, width: number, height: number) => {
      state.calls.preprocess.push({ photoPath, width, height });
      return `/tmp/wv-frame-${width}x${height}.png`;
    }),
    assertVideoSpawnPrerequisites: vi.fn(async () => undefined),
    spawnHoneydoVideo: vi.fn(async (opts: Record<string, unknown>) => {
      state.calls.spawn.push(opts);
      return { outPath: String(opts.outPath), duration: 4, stdout: "{}" };
    }),
    buildLoop: vi.fn(async (src: string, targetSeconds: number) => {
      state.calls.buildLoop.push({ src, targetSeconds });
      return { loopPath: src.replace(/\.mp4$/, "-loop.mp4"), segments: 4 };
    }),
    renderTextOverlay: vi.fn(async (videoPath: string, meta: Record<string, unknown>) => {
      state.calls.renderTextOverlay.push({ videoPath, meta });
      return { overlaidPath: videoPath.replace(/\.mp4$/, "-overlay.mp4") };
    }),
    // 尺寸护栏：mock 边界（真实 ffprobe 判别在 transcode 单测覆盖）
    assertVideoDimensions: vi.fn(async (filePath: string, w: number, h: number) => {
      state.calls.assertDims.push({ filePath, w, h });
    }),
    transcodeForAerialNative: vi.fn(async (src: string, dst: string) => {
      state.calls.transcodeAerialNative.push([src, dst]);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dst, "fake-mov");
    }),
    transcodeForGallery: vi.fn(async (src: string, dst: string) => {
      state.calls.transcodeGallery.push([src, dst]);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dst, "fake-mp4");
    }),
  };
});

vi.mock("../lib/cos/upload", () => ({
  uploadFile: vi.fn(async (localPath: string, cosKey: string, contentType: string) => {
    state.calls.upload.push({ localPath, cosKey, contentType });
    return state.uploadReturn;
  }),
}));

vi.mock("../lib/gallery/sync", () => ({
  syncDayToGallery: vi.fn(async (...args: unknown[]) => {
    state.calls.syncDay.push(args);
  }),
}));

import {
  getLargestFaceBbox,
  runWallpaperVideo,
  wallpaperVideoWorker,
} from "../jobs/wallpaper-video";

const PICK = {
  id: "pick-1",
  pickDate: "2026-09-12",
  photoId: "photo-1",
  title: "巷口的猫",
  narrative: "午后的光落在墙沿。",
  composedImagePath: "/tmp/wv-job-test-storage/daily-composed/2026-09-12_x.jpg",
};
const PHOTO = {
  id: "photo-1",
  filePath: "/photos/hero.jpg",
  mediaType: "image",
  takenAt: "2016-07-18T14:35:53.000Z",
};

beforeEach(() => {
  state.pickRows = [];
  state.photoRows = [];
  state.faceRows = [];
  state.updates = [];
  state.uploadReturn = "";
  state.heroDims = { width: 4000, height: 3000 };
  state.calls.dims = [];
  state.calls.spawn = [];
  state.calls.buildLoop = [];
  state.calls.renderTextOverlay = [];
  state.calls.assertDims = [];
  state.calls.transcodeAerialNative = [];
  state.calls.transcodeGallery = [];
  state.calls.upload = [];
  state.calls.syncDay = [];
  state.calls.preprocess = [];
  vi.clearAllMocks();
});

describe("runWallpaperVideo（20260928 单腿原生）", () => {
  it("开关关 → skip，零 honeydo 调用", async () => {
    const { config } = await import("../lib/config");
    const saved = config.wallpaperVideoEnabled;
    (config as { wallpaperVideoEnabled: boolean }).wallpaperVideoEnabled = false;
    try {
      const logs: string[] = [];
      const res = await runWallpaperVideo("2026-09-12", (m) => logs.push(m));
      expect(res).toEqual({ native: "", landscape: "" });
      expect(state.calls.spawn).toHaveLength(0);
      expect(logs.join("\n")).toContain("skip");
    } finally {
      (config as { wallpaperVideoEnabled: boolean }).wallpaperVideoEnabled = saved as boolean;
    }
  });

  it("无当日记录 → skip", async () => {
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ native: "", landscape: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("hero 是视频 → skip（Mac 走旧 dynamic HEIC 链路）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [{ ...PHOTO, mediaType: "video" }];
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ native: "", landscape: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("composedImagePath 为 null → skip", async () => {
    state.pickRows = [{ ...PICK, composedImagePath: null }];
    state.photoRows = [PHOTO];
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ native: "", landscape: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("happy path（4:3 hero，窗外）：单腿 spawn，画布 1248×928，仅 native 转码/上传/写列，无 .mov", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.faceRows = [{ x: 100, y: 200, w: 400, h: 500 }];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";

    const res = await runWallpaperVideo("2026-09-12", () => {});

    // 单腿：dims 读取 ×1、preprocess ×1（cover 微裁至 1248×928，20260928 三参签名无人脸窗口）
    expect(state.calls.dims).toHaveLength(1);
    expect(state.calls.preprocess).toHaveLength(1);
    expect(state.calls.preprocess[0]?.width).toBe(1248);
    expect(state.calls.preprocess[0]?.height).toBe(928);

    // spawn ×1：-r 720p + 画布逐轴覆盖（computeNativeCanvas(4000,3000) = 1248×928）
    expect(state.calls.spawn).toHaveLength(1);
    expect(state.calls.spawn[0]?.res).toBe("720p");
    expect(state.calls.spawn[0]?.firstFrame).toBe(state.calls.spawn[0]?.lastFrame);
    expect(state.calls.spawn[0]?.seconds).toBe(4);
    expect(state.calls.spawn[0]?.width).toBe(1248);
    expect(state.calls.spawn[0]?.height).toBe(928);

    // buildLoop / renderTextOverlay 各 ×1；meta 携画布宽高（comp 按比例选）
    expect(state.calls.buildLoop).toHaveLength(1);
    expect(String(state.calls.buildLoop[0]?.src)).toMatch(/2026-09-12-native-raw\.mp4$/);
    expect(state.calls.buildLoop[0]?.targetSeconds).toBe(8);
    expect(state.calls.renderTextOverlay).toHaveLength(1);
    expect(state.calls.renderTextOverlay[0]?.meta).toEqual({
      pickDate: "2026-09-12",
      title: "巷口的猫",
      narrative: "午后的光落在墙沿。",
      takenAt: "2016-07-18T14:35:53.000Z",
      canvasWidth: 1248,
      canvasHeight: 928,
    });

    // 转码 A（画廊原生）×1 + 尺寸护栏断言画布；转码 B（Aerial）不发生（1.34 < 1.5 窗外）
    expect(state.calls.transcodeGallery).toHaveLength(1);
    expect(String(state.calls.transcodeGallery[0]?.[1])).toMatch(/2026-09-12-native\.mp4$/);
    expect(state.calls.assertDims).toHaveLength(1);
    expect(state.calls.assertDims[0]).toEqual({
      filePath: expect.stringMatching(/2026-09-12-native\.mp4$/),
      w: 1248,
      h: 928,
    });
    expect(state.calls.transcodeAerialNative).toHaveLength(0);

    // COS 上传 ×1：native key + video/mp4；landscape 列不写
    expect(state.calls.upload).toHaveLength(1);
    expect(state.calls.upload[0]?.cosKey).toBe("relight/wallpaper-videos/2026-09-12_native.mp4");
    expect(state.calls.upload[0]?.contentType).toBe("video/mp4");

    // 回执非空 → 仅写 native 列（一次 UPDATE 合并）
    const written = state.updates.map((u) => u.vals);
    expect(written).toHaveLength(1);
    expect(written[0]?.wallpaperVideoNativeUrl).toBe(state.uploadReturn);
    expect("wallpaperVideoLandscapeUrl" in (written[0] ?? {})).toBe(false);

    // syncDayToGallery 复用；返回 {native, landscape}
    expect(state.calls.syncDay).toHaveLength(1);
    expect(res.native).toBe(state.uploadReturn);
    expect(res.landscape).toBe("");
  });

  it("happy path（16:9 hero，兼容窗口）：native + aerial 双产物双列", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.heroDims = { width: 3840, height: 2160 }; // 16:9 → 画布 1440×800（w/h=1.8 ∈ [1.5,1.9]）
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";

    const res = await runWallpaperVideo("2026-09-12", () => {});

    expect(state.calls.preprocess[0]?.width).toBe(1440);
    expect(state.calls.preprocess[0]?.height).toBe(800);
    expect(state.calls.spawn[0]?.width).toBe(1440);
    expect(state.calls.spawn[0]?.height).toBe(800);
    // 双转码 + 双护栏（native 画布 + aerial 1920×1080）
    expect(state.calls.transcodeGallery).toHaveLength(1);
    expect(state.calls.transcodeAerialNative).toHaveLength(1);
    expect(String(state.calls.transcodeAerialNative[0]?.[1])).toMatch(/2026-09-12-landscape\.mov$/);
    expect(state.calls.assertDims).toHaveLength(2);
    expect(state.calls.assertDims[1]).toEqual({
      filePath: expect.stringMatching(/2026-09-12-landscape\.mov$/),
      w: 1920,
      h: 1080,
    });
    // 双上传：native `_native.mp4` + aerial `_landscape.mov`
    expect(state.calls.upload).toHaveLength(2);
    expect(state.calls.upload[0]?.cosKey).toBe("relight/wallpaper-videos/2026-09-12_native.mp4");
    expect(state.calls.upload[1]?.cosKey).toBe("relight/wallpaper-videos/2026-09-12_landscape.mov");
    expect(state.calls.upload[1]?.contentType).toBe("video/quicktime");
    // 双列写入（一次 UPDATE 合并两列）
    const written = state.updates.map((u) => u.vals);
    expect(written).toHaveLength(1);
    expect(written[0]?.wallpaperVideoNativeUrl).toBe(state.uploadReturn);
    expect(written[0]?.wallpaperVideoLandscapeUrl).toBe(state.uploadReturn);
    expect(res.native).toBe(state.uploadReturn);
    expect(res.landscape).toBe(state.uploadReturn);
  });

  it("无 faces 记录 → faceBbox null（风景默认 prompt），链路照常", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.faceRows = [];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";

    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(state.calls.spawn).toHaveLength(1);
    expect(res.native).toBe(state.uploadReturn);
  });

  it("上传回执空串 → 不写 DB 列", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.uploadReturn = ""; // 上传失败语义（空串回执）

    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(state.calls.upload).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
    expect(res.native).toBe("");
  });

  it("生成失败（spawn throw）→ 两列均空旁路 log，不向调度层抛（契约 8）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";
    const { spawnHoneydoVideo } = await import("../lib/wallpaper/video");
    vi.mocked(spawnHoneydoVideo).mockImplementationOnce(async () => {
      throw new Error("honeydo video gen 退出码 1");
    });

    const logs: string[] = [];
    const res = await runWallpaperVideo("2026-09-12", (m) => logs.push(m));
    expect(res).toEqual({ native: "", landscape: "" });
    expect(state.updates).toHaveLength(0);
    expect(logs.join("\n")).toContain("native 腿失败");
  });

  it("尺寸护栏阻断（转码后 assertVideoDimensions throw）→ 两列均空（场景 5：禁静默失败）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.heroDims = { width: 3840, height: 2160 }; // 兼容窗口：aerial 护栏在 native 列写入前执行
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";
    const { assertVideoDimensions, DimensionAssertError } = await import("../lib/wallpaper/video");
    const dimMock = vi.mocked(assertVideoDimensions);
    const prevImpl = dimMock.getMockImplementation();
    dimMock.mockImplementation(async () => {
      throw new DimensionAssertError("转码产物尺寸断言失败: 期望 1920×1080，实际 1918×1080");
    });

    const logs: string[] = [];
    try {
      // 设计 D2/红队 SSOT 5.P1：尺寸护栏失败必须传播为 job 失败（rerun CLI exit≠0）
      let rejected = false;
      try {
        await runWallpaperVideo("2026-09-12", (m) => logs.push(m));
      } catch {
        rejected = true;
      }
      expect(rejected, "尺寸护栏失败必须传播为 job 失败").toBe(true);
      // 护栏在任一回执列写入之前 → 两列均空（契约 8 / 场景 5.P1）
      expect(state.updates).toHaveLength(0);
      expect(state.calls.upload).toHaveLength(0);
      expect(logs.join("\n")).toContain("尺寸断言失败");
    } finally {
      // 恢复工厂默认实现，防泄漏到后续测试（worker 透传等）
      dimMock.mockImplementation(
        prevImpl ??
          (async (filePath: string, w: number, h: number) => {
            state.calls.assertDims.push({ filePath, w, h });
          }),
      );
    }
  });
});

describe("getLargestFaceBbox", () => {
  it("faces 空表 → null（风景默认 prompt）", async () => {
    state.faceRows = [];
    await expect(getLargestFaceBbox("photo-1")).resolves.toBeNull();
  });

  it("faces 有记录 → 返回 bbox 形状 {x,y,w,h}", async () => {
    state.faceRows = [{ x: 10, y: 20, w: 300, h: 400 }];
    await expect(getLargestFaceBbox("photo-1")).resolves.toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 400,
    });
  });
});

describe("wallpaperVideoWorker", () => {
  it("job.data.pickDate 透传 runWallpaperVideo（单腿 spawn ×1）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    const job = {
      data: { pickDate: "2026-09-12" },
      log: (m: string) => undefined,
    };
    await wallpaperVideoWorker(job as never);
    expect(state.calls.spawn).toHaveLength(1);
  });
});
