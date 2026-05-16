/**
 * 验收测试：detectPersonsInMedia 函数契约（红队）
 *
 * 覆盖设计文档契约 1：
 * - 函数签名：detectPersonsInMedia(filePath, mediaType, opts) 必须导出
 * - PersonsResult 类型：persons 数组 + status 枚举
 * - status 枚举精确：ok | no_faces | model_unavailable | db_unavailable
 * - status != "ok" 时 persons 必为空数组（不能是 undefined）
 * - image / video 两种 mediaType 都被接受（不抛 TypeError）
 * - DetectPersonsOpts 接受 storageSourceId / sceneTimes 字段
 *
 * 红队铁律：
 * - 未读 detect-persons.ts 实现代码（文件尚不存在）
 * - 仅依据设计文档 §契约 1 编写
 * - 允许 vi.mock 外部 IO（face-detector/embedder/DB/ffmpeg）
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---- 在 import 实现前 mock 所有外部 IO ----
// face detector / embedder 是 ONNX 模型，需要真实模型文件，测试中不实际加载
vi.mock("../face/detector", () => ({
  FaceDetector: vi.fn().mockImplementation(() => ({
    detect: vi.fn().mockResolvedValue([]),
    load: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../face/embedder", () => ({
  FaceEmbedder: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue(new Float32Array(512)),
    load: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../face/prototypes", () => ({
  matchByPrototypes: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
  schema: {},
}));

// ffmpeg extractFrames 可能被视频路径触发
vi.mock("../media/ffmpeg", () => ({
  extractFrames: vi.fn().mockResolvedValue([]),
}));

// ---- PersonsResult zod schema（红队手写，对照设计文档）----
const personResultItemSchema = z.object({
  personId: z.string(),
  name: z.string(),
  frameCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
});

const personsResultSchema = z.object({
  persons: z.array(personResultItemSchema),
  status: z.enum(["ok", "no_faces", "model_unavailable", "db_unavailable"]),
});

// ---- 导入实现 ----
import type { DetectPersonsOpts, PersonsResult } from "../cli/vlog/lib/detect-persons";

describe("契约 1: detectPersonsInMedia 函数签名与类型契约", () => {
  describe("导出契约", () => {
    it("模块必须导出 detectPersonsInMedia 函数", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      expect(typeof mod.detectPersonsInMedia).toBe("function");
    });

    it("detectPersonsInMedia 必须接受 3 个参数（filePath, mediaType, opts）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      // Function.length 反映形参个数
      expect(mod.detectPersonsInMedia.length).toBe(3);
    });

    it("模块应当导出 PersonsResult 类型（通过 TypeScript 编译期检查，运行时跳过）", () => {
      // TypeScript 接口在运行时不存在，此 test 仅验证 import 不抛错
      const _typeCheck: DetectPersonsOpts = {
        storageSourceId: "test-source",
        sceneTimes: [1.5, 5.0],
      };
      expect(_typeCheck.storageSourceId).toBe("test-source");
    });
  });

  describe("返回值结构契约", () => {
    it("对不存在的图片文件应返回合法 PersonsResult 结构（不抛异常）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const result: PersonsResult = await mod.detectPersonsInMedia(
        "/tmp/nonexistent-photo-99999.jpg",
        "image",
        {},
      );
      const parsed = personsResultSchema.safeParse(result);
      expect(
        parsed.success,
        `返回值结构不符合 PersonsResult schema: ${JSON.stringify(parsed.error)}`,
      ).toBe(true);
    });

    it("对不存在的视频文件应返回合法 PersonsResult 结构（不抛异常）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const result: PersonsResult = await mod.detectPersonsInMedia(
        "/tmp/nonexistent-video-99999.mp4",
        "video",
        { sceneTimes: [1.0, 3.0] },
      );
      const parsed = personsResultSchema.safeParse(result);
      expect(
        parsed.success,
        `返回值结构不符合 PersonsResult schema: ${JSON.stringify(parsed.error)}`,
      ).toBe(true);
    });

    it("status 必须是 4 个枚举值之一（不接受任意字符串）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const result = await mod.detectPersonsInMedia("/tmp/ghost.jpg", "image", {});
      const validStatuses = ["ok", "no_faces", "model_unavailable", "db_unavailable"] as const;
      expect(validStatuses).toContain(result.status);
    });
  });

  describe("空数组规约", () => {
    it("status != 'ok' 时 persons 必须是空数组（不能是 undefined / null）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const result = await mod.detectPersonsInMedia("/tmp/ghost.jpg", "image", {});
      // 当 mock 让检测无法正常运行，status 不会是 ok
      if (result.status !== "ok") {
        expect(Array.isArray(result.persons)).toBe(true);
        expect(result.persons).toHaveLength(0);
      }
    });

    it("persons 字段无论 status 如何都必须是数组（不能是 undefined）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const result = await mod.detectPersonsInMedia("/tmp/ghost.mp4", "video", {});
      expect(result.persons).toBeDefined();
      expect(Array.isArray(result.persons)).toBe(true);
    });
  });

  describe("mediaType 参数契约", () => {
    it("mediaType='image' 不应抛出 TypeError", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      await expect(mod.detectPersonsInMedia("/tmp/ghost.jpg", "image", {})).resolves.toBeDefined();
    });

    it("mediaType='video' 不应抛出 TypeError", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      await expect(mod.detectPersonsInMedia("/tmp/ghost.mp4", "video", {})).resolves.toBeDefined();
    });
  });

  describe("opts 字段契约", () => {
    it("DetectPersonsOpts 接受 storageSourceId 字段", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const opts: DetectPersonsOpts = { storageSourceId: "source-abc" };
      await expect(
        mod.detectPersonsInMedia("/tmp/ghost.jpg", "image", opts),
      ).resolves.toBeDefined();
    });

    it("DetectPersonsOpts 接受 sceneTimes 数组字段（video 用）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      const opts: DetectPersonsOpts = { sceneTimes: [0.5, 2.0, 4.5, 8.0] };
      await expect(
        mod.detectPersonsInMedia("/tmp/ghost.mp4", "video", opts),
      ).resolves.toBeDefined();
    });

    it("空 opts 对象必须被接受（两个字段均可选）", async () => {
      const mod = await import("../cli/vlog/lib/detect-persons");
      await expect(mod.detectPersonsInMedia("/tmp/ghost.jpg", "image", {})).resolves.toBeDefined();
    });
  });
});
