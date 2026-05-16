/**
 * 验收测试：manifest schema 的 persons 字段（红队）
 *
 * 覆盖设计文档契约 2：
 * - batchManifestSchema 能解析含 persons 字段的 image entry
 * - batchManifestSchema 能解析含 persons 字段的 video entry
 * - persons 字段是 optional（缺失也能 parse）
 * - 每项 person 必须包含 personId / name / frameCount / confidence
 * - personsStatus 是 optional 且枚举值受限（4 个值）
 * - frameCount 接受 0（nonnegative）
 * - confidence 拒绝 > 1（max 1）
 * - confidence 接受 0（min 0）
 *
 * 红队铁律：
 * - 未读实现代码，仅依据设计文档 §契约 2
 * - 直接 import 已有 types.ts（这是已存在的 helper 文件）
 */
import { describe, expect, it } from "vitest";
import { batchManifestSchema } from "../cli/vlog/types";

// ---- 合法 manifest 基础结构 ----
function makeBaseManifest(files: unknown[]) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-16T10:00:00.000Z",
    rootDir: "/tmp/test-vlog",
    files,
    stats: {
      total: files.length,
      images: 0,
      videos: 0,
      ok: files.length,
      failed: 0,
      elapsedMs: 1000,
      cacheHits: 0,
    },
  };
}

// ---- 合法 image entry ----
const validImageEntry = {
  type: "image",
  ok: true,
  filePath: "/tmp/test/photo.jpg",
  realPath: "/tmp/test/photo.jpg",
  sha256: "a".repeat(64),
  fileSize: 1024,
  elapsedMs: 100,
  cacheHit: false,
  width: 1920,
  height: 1080,
};

// ---- 合法 video entry ----
const validVideoEntry = {
  type: "video",
  ok: true,
  filePath: "/tmp/test/video.mp4",
  realPath: "/tmp/test/video.mp4",
  sha256: "b".repeat(64),
  fileSize: 10240,
  elapsedMs: 200,
  cacheHit: false,
  width: 1920,
  height: 1080,
  durationSec: 10.5,
  videoCodec: "h264",
  videoFps: 30,
  hasAudio: true,
};

describe("契约 2: manifest schema persons 字段", () => {
  describe("image entry 支持 persons 字段", () => {
    it("能 parse 带 persons 字段的 image entry", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [
            { personId: "uuid-001", name: "爸爸", frameCount: 1, confidence: 0.92 },
            { personId: "uuid-002", name: "六六", frameCount: 1, confidence: 0.85 },
          ],
          personsStatus: "ok",
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, `schema 解析失败: ${JSON.stringify(result.error)}`).toBe(true);
    });

    it("image entry 缺少 persons 字段时仍能 parse（optional）", () => {
      const manifest = makeBaseManifest([{ ...validImageEntry }]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, `schema 解析失败: ${JSON.stringify(result.error)}`).toBe(true);
    });
  });

  describe("video entry 支持 persons 字段", () => {
    it("能 parse 带 persons 字段的 video entry", () => {
      const manifest = makeBaseManifest([
        {
          ...validVideoEntry,
          persons: [{ personId: "uuid-003", name: "妈妈", frameCount: 3, confidence: 0.88 }],
          personsStatus: "ok",
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, `schema 解析失败: ${JSON.stringify(result.error)}`).toBe(true);
    });

    it("video entry 缺少 persons 字段时仍能 parse（optional）", () => {
      const manifest = makeBaseManifest([{ ...validVideoEntry }]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, `schema 解析失败: ${JSON.stringify(result.error)}`).toBe(true);
    });
  });

  describe("person 数组项字段约束", () => {
    it("person 项必须包含 personId（string）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ name: "爸爸", frameCount: 1, confidence: 0.9 }], // 缺少 personId
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it("person 项必须包含 name（string）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", frameCount: 1, confidence: 0.9 }], // 缺少 name
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it("person 项必须包含 frameCount（number）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", confidence: 0.9 }], // 缺少 frameCount
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it("person 项必须包含 confidence（number）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1 }], // 缺少 confidence
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });
  });

  describe("frameCount 约束", () => {
    it("frameCount=0 应被接受（nonnegative）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 0, confidence: 0.5 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(
        result.success,
        `frameCount=0 应合法，但 parse 失败: ${JSON.stringify(result.error)}`,
      ).toBe(true);
    });

    it("frameCount 为负数应被拒绝", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: -1, confidence: 0.5 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it("frameCount 为浮点数应被拒绝（int 约束）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1.5, confidence: 0.5 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });
  });

  describe("confidence 约束", () => {
    it("confidence=0 应被接受（min(0)）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1, confidence: 0 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, "confidence=0 应合法").toBe(true);
    });

    it("confidence=1 应被接受（max(1)）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1, confidence: 1 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, "confidence=1 应合法").toBe(true);
    });

    it("confidence > 1 应被拒绝（max(1) 约束）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1, confidence: 1.01 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });

    it("confidence < 0 应被拒绝（min(0) 约束）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [{ personId: "uuid-001", name: "爸爸", frameCount: 1, confidence: -0.1 }],
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });
  });

  describe("personsStatus 约束", () => {
    it("personsStatus 是 optional（缺失应合法）", () => {
      const manifest = makeBaseManifest([
        {
          ...validImageEntry,
          persons: [],
          // personsStatus 缺失
        },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it("personsStatus='ok' 应被接受", () => {
      const manifest = makeBaseManifest([{ ...validImageEntry, persons: [], personsStatus: "ok" }]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it("personsStatus='no_faces' 应被接受", () => {
      const manifest = makeBaseManifest([
        { ...validImageEntry, persons: [], personsStatus: "no_faces" },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it("personsStatus='model_unavailable' 应被接受", () => {
      const manifest = makeBaseManifest([
        { ...validImageEntry, persons: [], personsStatus: "model_unavailable" },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it("personsStatus='db_unavailable' 应被接受", () => {
      const manifest = makeBaseManifest([
        { ...validImageEntry, persons: [], personsStatus: "db_unavailable" },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });

    it("personsStatus 为任意字符串应被拒绝（枚举约束）", () => {
      const manifest = makeBaseManifest([
        { ...validImageEntry, persons: [], personsStatus: "error" },
      ]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success).toBe(false);
    });
  });

  describe("旧 manifest 向后兼容", () => {
    it("同时含 image 和 video 且均无 persons 字段的旧 manifest 应能 parse", () => {
      const manifest = makeBaseManifest([{ ...validImageEntry }, { ...validVideoEntry }]);
      const result = batchManifestSchema.safeParse(manifest);
      expect(result.success, `旧 manifest 向后兼容失败: ${JSON.stringify(result.error)}`).toBe(
        true,
      );
    });
  });
});
