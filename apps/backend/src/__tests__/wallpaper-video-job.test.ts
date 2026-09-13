/**
 * 单测：wallpaper-video job 主流程（任务 4 + v2 增量任务 12/15）
 *
 * 契约（state.md ## 后端设计 4 / ## 契约规约；v2 修订）：
 *   runWallpaperVideo(pickDate)：
 *     - 开关关 → log skip 返回（零 honeydo 调用）
 *     - 无记录 / hero.isVideo / composedImagePath null → skip
 *     - faces 表取 hero 最大 bbox → preprocess（人脸构图；无脸 → 中心构图回退）
 *     - 每侧串接：spawn 生成 → buildLoop（palindrome）→ renderTextOverlay（Remotion 文字层）
 *       → 转码（横 Aerial hvc1 .mov 无音轨 / 竖 Gallery libx264+aac mp4 带音轨，输入=Remotion 成品）
 *     - COS 上传（video/quicktime 与 video/mp4），回执非空串才写 DB 列
 *     - syncDayToGallery 复用
 *   产物路径：{STORAGE_ROOT}/wallpaper-videos/{pickDate}-landscape.mov / {pickDate}-portrait.mp4
 *
 * 测试策略：mock ../db（真实 drizzle schema 列引用 + stub select/update）、
 * mock ../lib/wallpaper/video、../lib/cos/upload、../lib/gallery/sync、../lib/config。
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
    spawn: [] as Record<string, unknown>[],
    buildLoop: [] as { src: string; targetSeconds: number }[],
    renderTextOverlay: [] as { videoPath: string; meta: Record<string, unknown> }[],
    transcodeAerial: [] as unknown[][],
    transcodeGallery: [] as unknown[][],
    upload: [] as { localPath: string; cosKey: string; contentType: string }[],
    syncDay: [] as unknown[],
    preprocess: [] as {
      photoPath: string;
      width: number;
      height: number;
      opts: Record<string, unknown>;
    }[],
  },
  uploadReturn: "" as string,
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
    wallpaperVideoPrompt:
      "人物保持姿态稳定，只有轻微的呼吸起伏，动作轻柔，光影柔和流动，随后缓缓回到初始画面，如呼吸般自然",
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
    preprocessHeroFrame: vi.fn(
      async (photoPath: string, width: number, height: number, opts: Record<string, unknown>) => {
        state.calls.preprocess.push({ photoPath, width, height, opts });
        return `/tmp/wv-frame-${width}x${height}.png`;
      },
    ),
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
    transcodeForAerial: vi.fn(async (src: string, dst: string) => {
      state.calls.transcodeAerial.push([src, dst]);
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
  state.calls.spawn = [];
  state.calls.buildLoop = [];
  state.calls.renderTextOverlay = [];
  state.calls.transcodeAerial = [];
  state.calls.transcodeGallery = [];
  state.calls.upload = [];
  state.calls.syncDay = [];
  state.calls.preprocess = [];
  vi.clearAllMocks();
});

describe("runWallpaperVideo", () => {
  it("开关关 → skip，零 honeydo 调用", async () => {
    const { config } = await import("../lib/config");
    const saved = config.wallpaperVideoEnabled;
    (config as { wallpaperVideoEnabled: boolean }).wallpaperVideoEnabled = false;
    try {
      const logs: string[] = [];
      const res = await runWallpaperVideo("2026-09-12", (m) => logs.push(m));
      expect(res).toEqual({ landscape: "", portrait: "" });
      expect(state.calls.spawn).toHaveLength(0);
      expect(logs.join("\n")).toContain("skip");
    } finally {
      (config as { wallpaperVideoEnabled: boolean }).wallpaperVideoEnabled = saved as boolean;
    }
  });

  it("无当日记录 → skip", async () => {
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ landscape: "", portrait: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("hero 是视频 → skip（Mac 走旧 dynamic HEIC 链路）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [{ ...PHOTO, mediaType: "video" }];
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ landscape: "", portrait: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("composedImagePath 为 null → skip", async () => {
    state.pickRows = [{ ...PICK, composedImagePath: null }];
    state.photoRows = [PHOTO];
    const res = await runWallpaperVideo("2026-09-12", () => {});
    expect(res).toEqual({ landscape: "", portrait: "" });
    expect(state.calls.spawn).toHaveLength(0);
  });

  it("happy path（v2）：生成→buildLoop→renderTextOverlay→双转码（输入=Remotion 成品），COS 契约，回执写 DB，syncDayToGallery 复用", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.faceRows = [{ x: 100, y: 200, w: 400, h: 500 }];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";

    const res = await runWallpaperVideo("2026-09-12", () => {});

    // 人脸构图：preprocess 收到 faces 最大 bbox（两侧共用同一 bbox）
    expect(state.calls.preprocess).toHaveLength(2);
    expect(state.calls.preprocess[0]?.opts).toEqual({
      faceBbox: { x: 100, y: 200, w: 400, h: 500 },
    });
    expect(state.calls.preprocess[1]?.opts).toEqual({
      faceBbox: { x: 100, y: 200, w: 400, h: 500 },
    });

    // 两次 spawn：横（720p）在前，竖（portrait）在后；双锚定同图；seconds 透传 config（4）
    expect(state.calls.spawn).toHaveLength(2);
    expect(state.calls.spawn[0]?.res).toBe("720p");
    expect(state.calls.spawn[1]?.res).toBe("portrait");
    expect(state.calls.spawn[0]?.firstFrame).toBe(state.calls.spawn[0]?.lastFrame);
    expect(state.calls.spawn[0]?.seconds).toBe(4);

    // buildLoop：palindrome 目标时长 = config.wallpaperVideoLoopSeconds（8），输入=raw 生成
    expect(state.calls.buildLoop).toHaveLength(2);
    expect(String(state.calls.buildLoop[0]?.src)).toMatch(/2026-09-12-landscape-raw\.mp4$/);
    expect(state.calls.buildLoop[0]?.targetSeconds).toBe(8);

    // renderTextOverlay：输入=loop 产物，meta 透传 pickDate/title/narrative/takenAt
    expect(state.calls.renderTextOverlay).toHaveLength(2);
    expect(String(state.calls.renderTextOverlay[0]?.videoPath)).toMatch(
      /2026-09-12-landscape-raw-loop\.mp4$/,
    );
    expect(state.calls.renderTextOverlay[0]?.meta).toEqual({
      pickDate: "2026-09-12",
      title: "巷口的猫",
      narrative: "午后的光落在墙沿。",
      takenAt: "2016-07-18T14:35:53.000Z",
    });

    // 双轨转码输入 = Remotion 成品（*-loop-overlay.mp4）；横 → .mov（aerial），竖 → .mp4（gallery）
    expect(state.calls.transcodeAerial).toHaveLength(1);
    expect(String(state.calls.transcodeAerial[0]?.[0])).toMatch(
      /2026-09-12-landscape-raw-loop-overlay\.mp4$/,
    );
    expect(String(state.calls.transcodeAerial[0]?.[1])).toMatch(/2026-09-12-landscape\.mov$/);
    expect(state.calls.transcodeGallery).toHaveLength(1);
    expect(String(state.calls.transcodeGallery[0]?.[0])).toMatch(
      /2026-09-12-portrait-raw-loop-overlay\.mp4$/,
    );
    expect(String(state.calls.transcodeGallery[0]?.[1])).toMatch(/2026-09-12-portrait\.mp4$/);

    // COS 上传契约：key + contentType
    expect(state.calls.upload).toHaveLength(2);
    expect(state.calls.upload[0]?.cosKey).toBe("relight/wallpaper-videos/2026-09-12_landscape.mov");
    expect(state.calls.upload[0]?.contentType).toBe("video/quicktime");
    expect(state.calls.upload[1]?.cosKey).toBe("relight/wallpaper-videos/2026-09-12_portrait.mp4");
    expect(state.calls.upload[1]?.contentType).toBe("video/mp4");

    // 回执非空 → 写 DB 两列
    const written = state.updates.map((u) => u.vals);
    expect(written.some((v) => "wallpaperVideoLandscapeUrl" in v)).toBe(true);
    expect(written.some((v) => "wallpaperVideoPortraitUrl" in v)).toBe(true);

    // syncDayToGallery 复用
    expect(state.calls.syncDay).toHaveLength(1);

    expect(res.landscape).toBe(state.uploadReturn);
    expect(res.portrait).toBe(state.uploadReturn);
  });

  it("无 faces 记录 → faceBbox null（中心构图回退），链路照常", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.faceRows = [];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";

    const res = await runWallpaperVideo("2026-09-12", () => {});

    expect(state.calls.preprocess).toHaveLength(2);
    expect(state.calls.preprocess[0]?.opts).toEqual({ faceBbox: null });
    expect(res.landscape).toBe(state.uploadReturn);
  });

  it("上传回执空串 → 不写 DB 列（但另一侧成功仍写）", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    // 第一次调用（横）返回空串，第二次（竖）返回 URL —— 模拟横版上传失败
    const { uploadFile } = await import("../lib/cos/upload");
    const mockUpload = vi.mocked(uploadFile);
    let n = 0;
    mockUpload.mockImplementation(async () => {
      n += 1;
      return n === 1 ? "" : "https://b.cos.ap-shanghai.myqcloud.com/relight/x";
    });

    const res = await runWallpaperVideo("2026-09-12", () => {});
    const tables = state.updates.map((u) => ({
      field: Object.keys(u.vals)[0],
    }));
    expect(tables.some((t) => t.field === "wallpaperVideoLandscapeUrl")).toBe(false);
    expect(tables.some((t) => t.field === "wallpaperVideoPortraitUrl")).toBe(true);
    expect(res.landscape).toBe("");
  });

  it("单侧 buildLoop 失败 → 该侧空串旁路，另一侧照常", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    state.uploadReturn = "https://b.cos.ap-shanghai.myqcloud.com/relight/x";
    const { buildLoop } = await import("../lib/wallpaper/video");
    vi.mocked(buildLoop).mockImplementationOnce(async () => {
      throw new Error("buildLoop ffmpeg 拼接失败");
    });

    const logs: string[] = [];
    const res = await runWallpaperVideo("2026-09-12", (m) => logs.push(m));

    expect(res.landscape).toBe("");
    expect(res.portrait).toBe(state.uploadReturn);
    expect(logs.join("\n")).toContain("横版失败");
    // 横侧失败后竖侧仍完整走完
    expect(state.calls.renderTextOverlay).toHaveLength(1);
    expect(String(state.calls.renderTextOverlay[0]?.videoPath)).toMatch(/portrait-raw-loop\.mp4$/);
  });
});

describe("getLargestFaceBbox", () => {
  it("faces 空表 → null（中心构图回退）", async () => {
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
  it("job.data.pickDate 透传 runWallpaperVideo", async () => {
    state.pickRows = [PICK];
    state.photoRows = [PHOTO];
    const job = {
      data: { pickDate: "2026-09-12" },
      log: (m: string) => undefined,
    };
    await wallpaperVideoWorker(job as never);
    expect(state.calls.spawn).toHaveLength(2);
  });
});
